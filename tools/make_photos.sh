#!/bin/bash
# Render a PDF slide deck and distort each page so it looks like a phone photo taken in class.
# Usage: tools/make_photos.sh deck.pdf outdir [dpi]
set -e
PDF=$1; OUT=$2; DPI=${3:-200}
mkdir -p "$OUT"; pdftoppm -r "$DPI" -png "$PDF" "$OUT/s"
cd "$OUT"; i=0
for f in s-*.png; do
  i=$((i+1)); a=$(( (i*37)%5 - 2 ))
  convert "$f" -background '#cfcac0' -virtual-pixel background \
    -distort Perspective "0,0 $((60+i%3*16)),50  %[w],0 %[fx:w-40],$((16+i%4*10))  0,%[h] 36,%[fx:h-44]  %[w],%[h] %[fx:w-80],%[fx:h-12]" \
    -rotate $a \( +clone -sparse-color Barycentric '0,0 gray(82%) %[w],%[h] gray(100%)' \) -compose multiply -composite \
    -attenuate 0.4 +noise Gaussian -quality 75 "photo_$(printf %02d $i).jpg"
done
rm s-*.png
