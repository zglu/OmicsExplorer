# OmicsExplorer: extract a Seurat / SingleCellExperiment object from an .rds
# file into a transferable "parts" bundle (counts MatrixMarket, cell metadata,
# embeddings) that the Python side assembles into an .h5ad.
#
#   Rscript convert_rds.r <source.rds> <parts_dir>
#
# Outputs in <parts_dir>:
#   counts.mtx        features x cells  (MatrixMarket, coordinate format)
#   cells.txt         one cell name per line
#   features.txt      one feature name per line
#   meta.csv          cell metadata (first column: cell)
#   emb_<reduction>.csv  embedding coordinates (cells x dims, digitless header)
#   info.txt          summary lines "key=value"
# The script prints its progress to stdout; the Python wrapper shows it in the
# conversion log.

suppressWarnings(suppressPackageStartupMessages({
  if (!requireNamespace("Matrix", quietly = TRUE)) stop("R package 'Matrix' is required")
}))

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) stop("usage: convert_rds.r <source.rds> <parts_dir>")
src <- tools::file_path_as_absolute(args[[1]])
outdir <- args[[2]]
dir.create(outdir, recursive = TRUE, showWarnings = FALSE)

say <- function(...) cat("[rds]", ..., "\n")

info <- list()

say("loading", basename(src), "...")
obj <- try(readRDS(src), silent = TRUE)
if (inherits(obj, "try-error")) stop(as.character(obj))

get_sparse <- function(x) {
  if (inherits(x, "dgCMatrix")) return(x)
  say("coercing the matrix to sparse Csparse...")
  as(x, "dgCMatrix")
}

counts <- NULL
counts_from <- ""

if (inherits(obj, "Seurat")) {
  say("Seurat object,", length(colnames(obj)), "cells,", length(names(obj@assays)), "assay(s)")
  assay <- SeuratObject::DefaultAssay(obj)
  if (length(assay) == 0 && length(names(obj@assays))) assay <- names(obj@assays)[[1]]
  # Seurat v5 uses layers, v4 uses slots; try both
  fetch <- function(layer) {
    tryCatch(SeuratObject::GetAssayData(obj, assay = assay, layer = layer),
             error = function(e)
               tryCatch(SeuratObject::GetAssayData(obj, assay = assay, slot = layer),
                        error = function(e2) NULL))
  }
  counts <- fetch("counts")
  if (is.null(counts)) {
    counts <- fetch("data")
    if (!is.null(counts)) counts_from <- " (data layer - object has no counts)"
  }
  meta <- as.data.frame(obj@meta.data)
  meta$cell <- rownames(meta)
  red_names <- names(obj@reductions)
  embed <- function(r) SeuratObject::Embeddings(obj, r)
} else if (inherits(obj, c("SingleCellExperiment", "SummarizedExperiment"))) {
  say("SingleCellExperiment / SummarizedExperiment object")
  if (!requireNamespace("SummarizedExperiment", quietly = TRUE))
    stop("R package 'SummarizedExperiment' is required for this object")
  counts <- NULL
  cnames <- SummarizedExperiment::assayNames(obj)
  for (nm in cnames) {
    x <- SummarizedExperiment::assay(obj, nm)
    if (is.null(x) || length(dim(x)) != 2) next
    if (nrow(x) == 0 || ncol(x) == 0) next
    if (nm %in% c("counts", "logcounts")) {
      counts <- x
      if (nm == "logcounts") counts_from <- " (logcounts - object has no counts)"
      if (nm == "counts") break
    } else if (is.null(counts)) {
      counts <- x
      counts_from <- sprintf(" (assay '%s')", nm)
    }
  }
  meta <- as.data.frame(SummarizedExperiment::colData(obj))
  meta$cell <- rownames(meta)
  red_names <- if (inherits(obj, "SingleCellExperiment") && requireNamespace("SingleCellExperiment", quietly = TRUE))
    as.character(SingleCellExperiment::reducedDimNames(obj)) else character(0)
  embed <- function(r) SingleCellExperiment::reducedDim(obj, r)
} else if (is.matrix(obj) || inherits(obj, c("dgCMatrix", "dgTMatrix", "dgeMatrix"))) {
  say("bare matrix object")
  counts <- obj
  meta <- data.frame(cell = paste0("cell", seq_len(ncol(counts))))
  red_names <- character(0)
  embed <- function(r) stop("no embeddings")
} else {
  stop("unsupported object: class ", paste(class(obj), collapse = ", "),
       " - expected a Seurat object, SingleCellExperiment or a matrix")
}

if (is.null(counts) || nrow(counts) == 0 || ncol(counts) == 0)
  stop("the object carries no usable expression matrix")

counts <- get_sparse(counts)
cells <- colnames(counts)
if (length(cells) == 0) cells <- paste0("cell", seq_len(ncol(counts)))
features <- rownames(counts)
if (length(features) == 0) features <- paste0("gene", seq_len(nrow(counts)))
say("counts matrix:", nrow(counts), "features x", ncol(counts), "cells",
    sprintf("(%.1f%% non-zero%s)", 100 * length(counts@x) / (nrow(counts) * ncol(counts)), counts_from))

# ---- write parts -----------------------------------------------------------
say("writing counts.mtx ...")
invisible(Matrix::writeMM(counts, file.path(outdir, "counts.mtx")))

writeLines(cells, file.path(outdir, "cells.txt"))
writeLines(features, file.path(outdir, "features.txt"))

say("writing meta.csv ...")
if (!"cell" %in% names(meta)) meta$cell <- cells

# cell names like "bsTe_1" or "D35_bsFe_2" carry the sample and the replicate:
# offer them as groupings when the object does not have such a column
if (length(cells) && all(grepl("^(.*)_[0-9]+$", cells))) {
  prefix <- sub("^(.*)_[0-9]+$", "\\1", cells)
  replicate <- sub("^.*_([0-9]+)$", "\\1", cells)
  if (length(unique(prefix)) > 1) {
    known <- FALSE
    for (cn in names(meta)) {
      if (identical(as.character(meta[[cn]]), prefix)) { known <- TRUE; break }
    }
    if (!known && !("sample" %in% names(meta))) {
      meta$sample <- prefix
      say("derived a 'sample' column from the cell names")
    }
  }
  if (!("replicate" %in% names(meta))) meta$replicate <- replicate
}

meta <- meta[, order(names(meta)), drop = FALSE]
write.csv(meta, file.path(outdir, "meta.csv"), row.names = FALSE, na = "")

n_emb <- 0
for (r in red_names) {
  say("embedding:", r, "...")
  okish <- tryCatch({ emb <- embed(r); TRUE }, error = function(e) FALSE)
  if (!okish) next
  if (is.null(emb)) next
  ncol_out <- min(ncol(emb), 10)
  if (ncol_out < 2) next
  emb <- emb[, seq_len(ncol_out), drop = FALSE]
  df <- as.data.frame(emb)
  names(df) <- paste0("d", seq_len(ncol_out))
  safe <- tolower(gsub("[^a-z0-9]+", "_", tolower(r)))
  if (safe == "" || safe == "_") safe <- paste0("emb", n_emb + 1)
  fname <- file.path(outdir, paste0("emb_", safe, ".csv"))
  if (file.exists(fname)) next
  write.csv(df, fname, row.names = FALSE, na = "")
  n_emb <- n_emb + 1
  info[[length(info) + 1]] <- paste0("embedding=", safe)
}

info_blob <- c(
  paste0("class=", class(obj)[1]),
  paste0("n_cells=", length(cells)),
  paste0("n_features=", length(features)),
  paste0("n_meta=", max(0, ncol(meta) - 1)),
  paste0("n_embeddings=", n_emb),
  unlist(info)
)
writeLines(info_blob, file.path(outdir, "info.txt"))
say("parts written to", outdir)
say("done")
