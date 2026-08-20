# Third-Party Notices

DeCloud includes or derives from the following third-party works.
All notices below must be preserved in distributions of this software.

## liquid-taffy

The gooey "morphing dropdown" interaction in `static/js/modules/liquid.js`
and its styles in `static/css/app.css` (Liquid menu section) are a
dependency-free port of the morphing-dropdown interaction from:

- Project: liquid-taffy
- Author: arknow91
- Source: https://github.com/arknow91/liquid-taffy
- License: MIT

Portions used under the MIT License:

> Copyright (c) 2026 arknow91
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

Specifically ported: the goo-rim threshold table, the two spring
polylines, the grab chain geometry, the squircle path, the goo filter
graph, and the open/close choreography timings. React and GSAP from the
original were replaced with a small self-contained tween engine.
