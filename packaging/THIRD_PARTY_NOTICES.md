# Third-party notices

Unclip includes FFmpeg libraries built from the unmodified FFmpeg 8.1 release branch.
They are dynamically linked and configured without GPL or non-free components.
FFmpeg is licensed under the GNU Lesser General Public License, version 2.1 or later.

The macOS bundle includes FFmpeg's complete LGPL license text in
`Contents/Resources/COPYING.LGPLv2.1`. FFmpeg source is available from
https://github.com/FFmpeg/FFmpeg/tree/release/8.1.

Unclip uses `ffmpeg-next` and `ffmpeg-sys-next` as Rust bindings to the FFmpeg libraries,
and CPAL for native audio output. Their license metadata is included in Cargo.lock.

Unclip includes selected SVG icons from the Hugeicons free icon set, modified only
to use a white stroke. Copyright (c) 2025 Hugeicons. The free icon set is provided
under the MIT License; its license text is stored at `assets/icons/LICENSE-HUGEICONS.md`.
