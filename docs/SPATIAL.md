# Spatial data (Visium and friends)

OmicsExplorer reads spatial data from an **`.h5ad`** file.  Nothing special has
to be prepared: point it at the file and the tissue image, the spot positions
and the spot size are picked up automatically.

## What is read from the h5ad

```
obsm['spatial']            the 2-D coordinates of the spots / bins
uns['spatial'][sample]
    images/hires           the tissue image (written into the bundle as PNG)
    images/fullres        the full resolution image (only its size is used)
    scalefactors
        spot_diameter_fullres      the spot diameter in full resolution pixels
        tissue_hires_scalef        full resolution -> hires pixels
obs/...                    the groupings (cell_type, annotation, in_tissue, ...)
```

## The coordinate spaces

Visium files come with the coordinates in three different units - the
converter figures out which one it is (the coordinates have to fit into the
image they are measured in) and **converts everything to microns**:

| space | how it is recognised | what the converter does |
| --- | --- | --- |
| full resolution pixels | the coordinates fit into the fullres image but not into the hires image | converts them to microns (the Visium grid has a pitch of 100 µm) |
| hires pixels | the coordinates fit into the hires image | converts them to microns |
| microns | neither | keeps them |

The result is stored in `obsm['spatial']` (µm), so the scale bar, the spot
size and the tissue image are all consistent.

## The spot size

The distance between two neighbouring spots (the grid pitch) is measured with
the nearest neighbour distance - the median difference of the sorted
coordinates does not work for the hexagonal Visium layout, where every row is
offset by half a pitch.

The spot diameter comes from `spot_diameter_fullres` of the file.  It is
smaller than the pitch (a Visium spot is ~65 µm on a 100 µm grid), so the
spots are drawn as separate tiles with gaps - exactly like a Visium array
looks on a microscope slide.  Datasets without a spatial `uns` (Stereo-seq
bins for example) keep the old behaviour: the tiles fill the grid seamlessly.

## Rendering

* the spots are drawn as squares (a grid), their size grows with the zoom, so
  the tissue never falls apart into separate dots
* the tissue image is offered as a background ("Tissue image" in the card) and
  is aligned with the spots by the transform that the converter computed

## Visium HD

Space Ranger 3 writes the 2 µm bins into
`outs/binned_outputs/square_002um` - 11 million rows for a 6.5 mm capture
area, which is far too much.  Use the 8 µm or 16 µm bins instead
(`square_008um`, `square_016um`); they contain 1/16 and 1/64 of the rows and
are what Space Ranger analyses by default.  The 16 µm bins (≈165k rows) work
comfortably, the 8 µm bins (≈660k) are heavy but possible.

## Converting a Space Ranger output

An h5ad is the easiest way in.  For a raw Space Ranger output, convert it
first (R or Python), for example with Seurat:

```r
obj <- Read10X_Image(...)
```

and keep `uns['spatial']` - that is where the converter finds the image and
the scale factors.
