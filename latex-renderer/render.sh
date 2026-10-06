#!/bin/sh
set -eu

profile='jobtrack-latex-pdf-v1'
version='jobtrack-texlive-2026.2'
active_content_policy='jobtrack-pdf-active-content.v1'
build_dir="$(mktemp -d /tmp/jobtrack-latex.XXXXXX)"
trap 'rm -rf "$build_dir"' EXIT INT TERM

test -f /input/document.tex
test ! -L /input/document.tex
test -d /output

cp /input/document.tex "$build_dir/document.tex"
cd "$build_dir"

run_pdflatex() {
  pass="$1"
  log="/tmp/jobtrack-pdflatex-$pass.log"
  if ! pdflatex -no-shell-escape -interaction=nonstopmode -halt-on-error -file-line-error \
    -output-directory="$build_dir" document.tex >"$log" 2>&1; then
    tail -c 4000 "$log" >&2
    exit 1
  fi
}
run_pdflatex 1
run_pdflatex 2

test -f "$build_dir/document.pdf"
test ! -L "$build_dir/document.pdf"
qpdf --check "$build_dir/document.pdf" >/tmp/jobtrack-qpdf-check.txt 2>&1
# qpdf parses object streams and indirect dictionaries before jq evaluates the
# resulting object graph. Reject active actions, remote navigation, embedded
# payloads, rich media, and scripting by both dictionary name and action value.
qpdf_json='/tmp/jobtrack-qpdf.json'
qpdf --json "$build_dir/document.pdf" >"$qpdf_json"
if ! jq -e '
  def resolve_ref($document):
    . as $value
    | if type == "string" and test("^[0-9]+ [0-9]+ R$")
      then $document.qpdf[1]["obj:\($value)"].value
      else $value
      end;
  . as $document
  | ([.. | objects | keys[] | ascii_downcase] + [.. | strings | ascii_downcase]) as $tokens
  | [.. | objects | keys[] | select(test("#[0-9A-Fa-f]{2}"))] as $escaped_names
  | [
      "/aa", "/javascript", "/js", "/launch", "/embeddedfiles",
      "/richmedia", "/submitform", "/importdata", "/gotor", "/gotoe", "/rendition",
      "/embeddedfile", "/fileattachment", "/filespec", "/ef", "/acroform", "/xfa",
      "/movie", "/sound", "/3d", "/3dd", "/3dv", "/3da"
    ] as $forbidden
  | [
      .. | objects | to_entries[]
      | select((.key | ascii_downcase) == "/openaction")
      | .value
    ] as $open_actions
  | [
      .. | objects | to_entries[]
      | select((.key | ascii_downcase) == "/uri")
      | .value
    ] as $uris
  | ($escaped_names | length) == 0
    and ($forbidden | all(.[]; . as $name | ($tokens | index($name) | not)))
    and ($open_actions | all(.[];
      resolve_ref($document) as $action
      | (($action | type) == "array"
          and ($action | length) >= 2
          and (($action[0] | type) == "string")
          and ($action[0] | test("^[0-9]+ [0-9]+ R$"))
          and (($action[1] | type) == "string")
          and ($action[1] | test("^/(Fit|FitB|FitH|FitV|FitBH|FitBV|XYZ)$")))
        or (($action | type) == "object"
          and ($action["/S"] == "/GoTo")
          and ($action | has("/D"))
          and (($action | keys - ["/D", "/S"]) | length) == 0)
    ))
    and ($uris | all(.[];
      type == "string"
      and (sub("^u:"; "") | test("^(https?://|mailto:|tel:)"; "i"))
    ))
' "$qpdf_json" >/dev/null; then
  printf '%s\n' 'PDF rejected by jobtrack-pdf-active-content.v1' >&2
  exit 1
fi
pdfinfo "$build_dir/document.pdf" >/tmp/jobtrack-pdfinfo.txt
pages="$(awk -F: '/^Pages:/ { gsub(/[[:space:]]/, "", $2); print $2 }' /tmp/jobtrack-pdfinfo.txt)"
case "$pages" in
  ''|*[!0-9]*) exit 1 ;;
esac
test "$pages" -gt 0
pdfinfo -f 1 -l "$pages" -box "$build_dir/document.pdf" >/tmp/jobtrack-pdfinfo-pages.txt
awk -v expected="$pages" '
  /^Page[[:space:]]+[0-9]+[[:space:]]+size:/ {
    numbered += 1
    width = $4
    height = $6
    if (!(width > 0 && height > 0 && width <= 2000 && height <= 2000)) invalid = 1
    next
  }
  /^Page size:/ {
    generic += 1
    width = $3
    height = $5
    if (!(width > 0 && height > 0 && width <= 2000 && height <= 2000)) invalid = 1
  }
  END {
    if (invalid) exit 1
    if (numbered > 0) {
      if (numbered != expected) exit 1
    } else if (!(expected == 1 && generic == 1)) {
      exit 1
    }
  }
' /tmp/jobtrack-pdfinfo-pages.txt

pdftotext -layout "$build_dir/document.pdf" "$build_dir/document.txt"
test -s "$build_dir/document.txt"
text_sha="$(sha256sum "$build_dir/document.txt" | awk '{print $1}')"
pdf_sha="$(sha256sum "$build_dir/document.pdf" | awk '{print $1}')"
active_content_scan_sha="$(printf '%s\n%s\nclean\n' "$active_content_policy" "$pdf_sha" | sha256sum | awk '{print $1}')"

cp "$build_dir/document.pdf" /output/document.pdf
cp "$build_dir/document.txt" /output/document.txt
printf '{"rendererProfile":"%s","rendererVersion":"%s","pageCount":%s,"extractedTextSha256":"%s","activeContentPolicy":"%s","activeContentScanSha256":"%s"}\n' \
  "$profile" "$version" "$pages" "$text_sha" "$active_content_policy" "$active_content_scan_sha" > /output/metadata.json
chmod 0600 /output/document.pdf /output/document.txt /output/metadata.json
