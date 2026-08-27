# The Study's painted panels — how they were made

Every raster image in the Sixth History theme is generated, and every generated
image that ships has a sheet here recording exactly what produced it. One sheet
per panel, named for the panel it makes.

The rooms were not painted from nothing. Each is a **repaint** of a reference
photograph of a real interior, run through
[`black-forest-labs/flux-kontext-pro`](https://replicate.com/black-forest-labs/flux-kontext-pro)
with the prompt in its sheet — which is why they share a palette and a flat,
straight-on elevation that eight independent generations would not have.

## Reproducing a panel

```sh
curl -s -X POST https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions \
  -H "Authorization: Bearer $(cat ~/.config/replicate/token)" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: wait' \
  -d "$(jq -n --arg p "$PROMPT" --arg img "data:image/jpeg;base64,$(base64 -i "$REFERENCE")" \
        '{input: {prompt: $p, input_image: $img, aspect_ratio: "21:9", output_format: "png"}}')"
```

`$PROMPT` is the sheet's `input.prompt`, verbatim. `21:9` is what makes the
1568×672 panel the manifest declares as that room's `natural` size.

Generation is not deterministic and the model takes no seed, so the same call
returns a different painting each time. A sheet reproduces the *intent*, not
the bytes; the shipped PNG is the artefact.

## The reference images are deliberately not here

The request carried its reference inline as a `data:` URI — 170–410KB of base64
each, and nothing recorded the file it came from. Checking eight of those into
a repository to sit next to the PNGs they already produced would add megabytes
that no build reads.

Each sheet therefore identifies its reference by `sha256` and byte length
instead, so a candidate file can be confirmed to be the right one before a
repaint is attempted. `card-table.yaml` and `shelves.yaml` share a digest:
both rooms are repaints of the same photograph.

## What is not generated

Card frames, ornament and icons are hand-authored SVG. Nothing in this
directory touches them.
