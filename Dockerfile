# OmicsExplorer - a ready-to-use container for the web UI.
#
#   docker build -t omicsexplorer .
#   docker run --rm -p 8080:8080 -v "$PWD/my_project:/project" omicsexplorer
#
# The image contains R + Seurat, so Seurat .rds files can be uploaded through
# the web UI as well.
#
# A smaller image without R (.h5ad only):
#
#   docker build --build-arg WITH_R=0 \
#       --build-arg BASE_IMAGE=python:3.12-slim-bookworm -t omicsexplorer:slim .
#
# Apptainer / Singularity:
#   apptainer build omicsexplorer.sif docker-daemon://omicsexplorer:latest
#   apptainer run --bind "$PWD/my_project:/project" omicsexplorer.sif
#
ARG BASE_IMAGE=rocker/r-ver:4.4.2
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.title="OmicsExplorer" \
      org.opencontainers.image.description="Single-cell & spatial omics viewer (web UI, local data)" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    OMICSEXPLORER_HOME=/project \
    PATH=/opt/omicsexplorer/bin:$PATH \
    R_LIBS_SITE=/usr/local/lib/R/site-library

ARG WITH_R=1
# the official python images ship their own interpreter, then this is empty
ARG PY_PKGS="python3.12 python3.12-venv python3.12-dev"

# ---------------------------------------------------------------- system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        ${PY_PKGS} \
        build-essential git ca-certificates curl \
        libcurl4-openssl-dev libssl-dev zlib1g-dev \
        libicu-dev libpng-dev libjpeg-dev libtiff5-dev libfreetype6-dev \
        libfontconfig1-dev libhdf5-dev \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------- R extras
RUN if [ "$WITH_R" = "1" ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            r-cran-matrix r-cran-rcpp r-cran-rcppeigen r-cran-rcpparmadillo \
            r-cran-rlang r-cran-glue r-cran-vctrs r-cran-cli r-cran-lifecycle \
            r-cran-generics r-cran-tibble r-cran-pillar r-cran-magrittr \
            r-cran-dplyr r-cran-tidyr r-cran-purrr r-cran-stringr r-cran-stringi \
            r-cran-ggplot2 r-cran-scales r-cran-viridis r-cran-irlba r-cran-uwot \
            r-cran-rann r-cran-future r-cran-future.apply r-cran-jsonlite \
            r-cran-rspectra r-cran-rcolorbrewer r-cran-htmltools r-cran-knitr \
            r-bioc-biocgenerics r-bioc-s4vectors r-bioc-iranges r-bioc-genomicranges \
            r-bioc-genomicfeatures r-bioc-summarizedexperiment r-bioc-delayedarray \
            r-bioc-singlecellexperiment r-bioc-matrixgenerics \
        && rm -rf /var/lib/apt/lists/* ; \
        NPROC=$(nproc) && \
        R -q -e "install.packages(c('Seurat', 'SeuratObject'), repos='https://cloud.r-project.org', Ncpus=${NPROC})" && \
        R -q -e "stopifnot(requireNamespace('Seurat', quietly=TRUE))" ; \
    fi

# --------------------------------------------------------------- python / app
WORKDIR /src
COPY pyproject.toml README.md ./
COPY omicsexplorer ./omicsexplorer
COPY web ./web
RUN python3.12 -m venv /opt/omicsexplorer \
    && /opt/omicsexplorer/bin/pip install --no-cache-dir --upgrade pip wheel \
    && /opt/omicsexplorer/bin/pip install --no-cache-dir ".[server]"

# ------------------------------------------------------------------- runtime
ENV OMICSEXPLORER_WEB=/opt/omicsexplorer/lib/python3.12/site-packages/web
VOLUME ["/project"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

COPY docker/entrypoint.sh /usr/local/bin/omicsexplorer-entrypoint
RUN chmod +x /usr/local/bin/omicsexplorer-entrypoint
ENTRYPOINT ["/usr/local/bin/omicsexplorer-entrypoint"]
CMD ["serve", "-p", "/project/project.yaml", "--host", "0.0.0.0", "--port", "8080"]
