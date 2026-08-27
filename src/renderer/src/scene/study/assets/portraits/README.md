# The Study's portrait pack

Drop portrait images here (`.png`, `.jpg`, `.webp`) and every assistant's card
in the Study picks one up. An empty pack is a supported state: cards fall back
to a monogram in the display face, which is why the app looks finished before
any art exists.

Two rules govern what may go in this directory, and both are licence
obligations rather than preferences — see
`src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md`:

1. Only images from the Sixth History community asset pack, or artwork
   generated for this project. Never other Weather Factory art.
2. Record each file's provenance in the attribution document as it lands.

After adding or removing files, regenerate the static index the bundler builds
from:

    node make-portrait-index.cjs

A test compares the generated index against this directory, so forgetting that
step fails the suite rather than silently dropping the new portraits.
