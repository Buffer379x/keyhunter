#!/bin/sh
# Parser canary (PROD-13): before a release, check by hand that the shop parsers still find products with prices.
# It makes ONE product page request per shop (plus the shop's robots.txt) through the app's own client, with the
# user agent "Keyhunter", respecting robots.txt and the crawl delay. It never runs in tests, CI or check.sh.
#
#   KEYHUNTER_CANARY_CONSENT=1 sh deploy/parser-canary.sh <eneba-product-link> [<driffle-product-link>]
#
# It always lists what a run contacts first; only with consent does it start the run. KEYHUNTER_IMAGE selects the
# image to test (default: the release image on GHCR). The app itself refuses anything but one product link per shop.
set -eu
if [ "$#" -eq 0 ]; then
  echo "Usage: KEYHUNTER_CANARY_CONSENT=1 sh deploy/parser-canary.sh <product-link>... (one per shop)" >&2
  exit 2
fi
image=${KEYHUNTER_IMAGE:-ghcr.io/buffer379x/keyhunter:latest}
echo "Image: $image"
echo "This run contacts, with the user agent \"Keyhunter\", respecting robots.txt and the crawl delay:"
for link in "$@"; do
  rest=${link#https://}
  echo "  https://${rest%%/*}/robots.txt and $link"
done
if [ "${KEYHUNTER_CANARY_CONSENT:-}" != 1 ]; then
  echo "Refused: nothing was contacted. Read docs/operations.md (Parserprüfung vor dem Release), then run again with KEYHUNTER_CANARY_CONSENT=1." >&2
  exit 2
fi
# A throwaway container without the data volume: the canary neither reads nor writes the database.
exec docker run --rm --user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e KEYHUNTER_CANARY_CONSENT=1 "$image" --canary "$@"
