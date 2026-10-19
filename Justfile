# Everything builds in app/ (app/Justfile): these forward there, so `just dev`
# works from the top of the repo too.

default:
    @just --justfile app/Justfile --list

app *args:
    @just --justfile app/Justfile app {{args}}

bundle *args:
    @just --justfile app/Justfile bundle {{args}}

check *args:
    @just --justfile app/Justfile check {{args}}

dev *args:
    @just --justfile app/Justfile dev {{args}}

ffmpeg *args:
    @just --justfile app/Justfile ffmpeg {{args}}

native *args:
    @just --justfile app/Justfile native {{args}}

native-compiled *args:
    @just --justfile app/Justfile native-compiled {{args}}

native-test *args:
    @just --justfile app/Justfile native-test {{args}}

publish *args:
    @just --justfile app/Justfile publish {{args}}

release *args:
    @just --justfile app/Justfile release {{args}}

serve *args:
    @just --justfile app/Justfile serve {{args}}

serve-build *args:
    @just --justfile app/Justfile serve-build {{args}}

serve-build-bin *args:
    @just --justfile app/Justfile serve-build-bin {{args}}

types *args:
    @just --justfile app/Justfile types {{args}}

wasm *args:
    @just --justfile app/Justfile wasm {{args}}

web *args:
    @just --justfile app/Justfile web {{args}}

web-install *args:
    @just --justfile app/Justfile web-install {{args}}

window *args:
    @just --justfile app/Justfile window {{args}}
