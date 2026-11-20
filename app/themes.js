// Color themes: omonitor's own palette (the .mc rules in Mission Control.dc.html) and opencode2's built-in themes, so
// the dashboard and the chat can wear the colors the opencode2 terminal shows. Pure data and CSS text; the page applies
// it (Mission Control.dc.html setTheme).
//
// THEMES comes from anomalyco/opencode packages/tui/src/theme at 4f98dcb (2026-11-19): the V1 files registered in
// v1.ts plus assets/v2/opencode.json and opencode-classic.json (the `system` theme reads the terminal's palette and has
// no browser counterpart). Each entry is [dark, light]: one string of colors in COLS order, or null when the theme
// has a single mode (also when its light colors repeat the dark ones). The V1 keys behind COLS are background,
// backgroundPanel, backgroundElement, text, textMuted, primary, error, warning, diffAdded, diffRemoved, diffAddedBg,
// diffRemovedBg and markdownText, markdownHeading, markdownLinkText, markdownCode, markdownBlockQuote, markdownEmph,
// markdownStrong, markdownHorizontalRule, markdownListItem, markdownCodeBlock. A V2 file gives the same roles through
// background.base, background.raised.base and .high, text.base, text.muted, text.action.primary.$selected,
// text.feedback.*, diff.* and markdown.*.
const COLS = ['bg', 'panel', 'element', 'text', 'muted', 'primary', 'error', 'warning', 'added', 'removed', 'addedBg', 'removedBg',
  'mdText', 'mdHeading', 'mdLink', 'mdCode', 'mdQuote', 'mdEmph', 'mdStrong', 'mdHr', 'mdList', 'mdCodeBlock'];
const THEMES = {
  'opencode': ['#080808 #141414 #202020 #ffffff #808080 #7699fe #ef6c6c #f5a742 #4fd6be #c53b53 #20303b #37222c #eeeeee #9d7cd8 #56b6c2 #7fd88f #e5c07b #e5c07b #f5a742 #808080 #fab283 #eeeeee', '#ffffff #f2f2f2 #eeeeee #101010 #808080 #6c8ffe #ec6262 #d68c27 #1e725c #c53b53 #d5e5d5 #f7d8db #1a1a1a #d68c27 #318795 #3d9a57 #b0851f #b0851f #d68c27 #8a8a8a #3b7dd8 #1a1a1a'],
  'opencode-classic': ['#0a0a0a #141414 #1e1e1e #eeeeee #808080 #fab283 #e06c75 #f5a742 #4fd6be #c53b53 #20303b #37222c #eeeeee #9d7cd8 #56b6c2 #7fd88f #e5c07b #e5c07b #f5a742 #808080 #fab283 #eeeeee', '#ffffff #fafafa #f5f5f5 #1a1a1a #8a8a8a #3b7dd8 #d1383d #d68c27 #1e725c #c53b53 #d5e5d5 #f7d8db #1a1a1a #d68c27 #318795 #3d9a57 #b0851f #b0851f #d68c27 #8a8a8a #3b7dd8 #1a1a1a'],
  'aura': ['#0f0f0f #15141b #15141b #edecee #6d6d6d #a277ff #ff6767 #ffca85 #61ffca #ff6767 #354933 #3f191a #edecee #a277ff #a277ff #61ffca #6d6d6d #ffca85 #a277ff #6d6d6d #a277ff #edecee', null],
  'ayu': ['#0b0e14 #0f131a #0d1017 #bfbdb6 #565b66 #59c2ff #d95757 #e6b673 #7fd962 #f26d78 #20303b #37222c #bfbdb6 #d2a6ff #39bae6 #aad94c #e6b673 #e6b673 #ffb454 #565b66 #59c2ff #bfbdb6', null],
  'carbonfox': ['#161616 #1a1a1a #1e1e1e #f2f4f8 #7d848f #33b1ff #ee5396 #f1c21b #50fa7b #ff6b6b #0f2418 #2a1216 #f2f4f8 #8cb6ff #33b1ff #25be6a #7d848f #be95ff #ffffff #303030 #33b1ff #a9afbc', '#ffffff #f4f4f4 #f4f4f4 #161616 #6f6f6f #0043ce #9f1853 #007d79 #198038 #9f1853 #defbe6 #fff1f1 #161616 #0043ce #0072c3 #198038 #6f6f6f #6929c4 #000000 #dcdcdc #0072c3 #525252'],
  'catppuccin': ['#1e1e2e #181825 #11111b #cdd6f4 #9399b2 #89b4fa #f38ba8 #f9e2af #a6e3a1 #f38ba8 #24312b #3c2a32 #cdd6f4 #cba6f7 #89dceb #a6e3a1 #f9e2af #f9e2af #fab387 #a6adc8 #89b4fa #cdd6f4', '#eff1f5 #e6e9ef #dce0e8 #4c4f69 #7c7f93 #1e66f5 #d20f39 #df8e1d #40a02b #d20f39 #d6f0d9 #f6dfe2 #4c4f69 #8839ef #04a5e5 #40a02b #df8e1d #df8e1d #fe640b #6c6f85 #1e66f5 #4c4f69'],
  'catppuccin-frappe': ['#303446 #292c3c #232634 #c6d0f5 #949cb8 #8da4e2 #e78284 #e5c890 #a6d189 #e78284 #29342b #3a2a31 #c6d0f5 #ca9ee6 #99d1db #a6d189 #e5c890 #e5c890 #ef9f76 #a5adce #8da4e2 #c6d0f5', null],
  'catppuccin-macchiato': ['#24273a #1e2030 #181926 #cad3f5 #939ab7 #8aadf4 #ed8796 #eed49f #a6da95 #ed8796 #29342b #3a2a31 #cad3f5 #c6a0f6 #91d7e3 #a6da95 #eed49f #eed49f #f5a97f #a5adcb #8aadf4 #cad3f5', null],
  'cobalt2': ['#193549 #122738 #1f4662 #ffffff #adb7c9 #0088ff #ff0088 #ffc600 #9eff80 #ff0088 #1a3a2a #3a1a2a #ffffff #ffc600 #2affdf #9eff80 #adb7c9 #ff9d00 #ff628c #2d5a7b #0088ff #ffffff', '#ffffff #f5f7fa #e8ecf1 #193549 #5c6b7d #0066cc #e91e63 #ff9800 #4caf50 #e91e63 #e8f5e9 #ffebee #193549 #ff9800 #00acc1 #4caf50 #5c6b7d #ff5722 #e91e63 #d3dae3 #0066cc #193549'],
  'cursor': ['#181818 #141414 #262626 #e4e4e4 #e4e4e45e #88c0d0 #e34671 #f1b467 #3fa266 #e34671 #3fa26633 #b8004933 #e4e4e4 #aaa0fa #81a1c1 #e394dc #e4e4e45e #82d2ce #f8c762 #e4e4e45e #e4e4e4 #e4e4e4', '#fcfcfc #f3f3f3 #ededed #141414 #141414ad #6f9ba6 #cf2d56 #db704b #1f8a65 #cf2d56 #1f8a651f #cf2d5614 #141414 #206595 #141414ad #1f8a65 #141414ad #141414 #141414 #141414ad #141414 #141414'],
  'dracula': ['#282a36 #21222c #44475a #f8f8f2 #6272a4 #bd93f9 #ff5555 #f1fa8c #50fa7b #ff5555 #1a3a1a #3a1a1a #f8f8f2 #bd93f9 #ff79c6 #50fa7b #6272a4 #f1fa8c #ffb86c #6272a4 #bd93f9 #f8f8f2', '#f8f8f2 #e8e8e2 #d8d8d2 #282a36 #6272a4 #bd93f9 #ff5555 #f1fa8c #50fa7b #ff5555 #e0ffe0 #ffe0e0 #282a36 #bd93f9 #ff79c6 #50fa7b #6272a4 #f1fa8c #ffb86c #6272a4 #bd93f9 #282a36'],
  'everforest': ['#2d353b #333c43 #343f44 #d3c6aa #7a8478 #a7c080 #e67e80 #e69875 #4fd6be #c53b53 #20303b #37222c #d3c6aa #d699b6 #83c092 #a7c080 #dbbc7f #dbbc7f #e69875 #7a8478 #a7c080 #d3c6aa', '#fdf6e3 #efebd4 #f4f0d9 #5c6a72 #a6b0a0 #8da101 #f85552 #f57d26 #1e725c #c53b53 #d5e5d5 #f7d8db #5c6a72 #df69ba #35a77c #8da101 #dfa000 #dfa000 #f57d26 #a6b0a0 #8da101 #5c6a72'],
  'flexoki': ['#100f0f #1c1b1a #282726 #cecdc3 #6f6e69 #da702c #d14d41 #da702c #879a39 #d14d41 #1a2d1a #2d1a1a #cecdc3 #8b7ec8 #3aa99f #3aa99f #d0a215 #d0a215 #da702c #6f6e69 #da702c #cecdc3', '#fffcf0 #f2f0e5 #e6e4d9 #100f0f #6f6e69 #205ea6 #af3029 #bc5215 #66800b #af3029 #d5e5d5 #f7d8db #100f0f #5e409d #24837b #24837b #ad8301 #ad8301 #bc5215 #6f6e69 #bc5215 #100f0f'],
  'github': ['#0d1117 #010409 #161b22 #c9d1d9 #8b949e #58a6ff #f85149 #e3b341 #3fb950 #f85149 #033a16 #67060c #c9d1d9 #58a6ff #39c5cf #ff7b72 #8b949e #e3b341 #d29922 #30363d #58a6ff #c9d1d9', '#ffffff #f6f8fa #f0f3f6 #24292f #57606a #0969da #cf222e #9a6700 #1a7f37 #cf222e #dafbe1 #ffebe9 #24292f #0969da #1b7c83 #bf3989 #57606a #9a6700 #bc4c00 #d0d7de #0969da #24292f'],
  'gruvbox': ['#282828 #3c3836 #504945 #ebdbb2 #928374 #83a598 #fb4934 #fe8019 #98971a #cc241d #32302f #322929 #ebdbb2 #83a598 #b8bb26 #fabd2f #928374 #d3869b #fe8019 #928374 #83a598 #ebdbb2', '#fbf1c7 #ebdbb2 #d5c4a1 #3c3836 #7c6f64 #076678 #9d0006 #af3a03 #79740e #9d0006 #dcd8a4 #e2c7c3 #3c3836 #076678 #79740e #b57614 #7c6f64 #8f3f71 #af3a03 #7c6f64 #076678 #3c3836'],
  'kanagawa': ['#1f1f28 #2a2a37 #363646 #dcd7ba #727169 #7e9cd8 #e82424 #d7a657 #98bb6c #e82424 #252e25 #362020 #dcd7ba #957fb8 #76946a #98bb6c #727169 #c38d9d #d7a657 #727169 #7e9cd8 #dcd7ba', '#f2e9de #eae4d7 #e3dcd2 #54433a #9e9389 #2d4f67 #e82424 #d7a657 #98bb6c #e82424 #eaf3e4 #fbe6e6 #54433a #957fb8 #76946a #98bb6c #9e9389 #c38d9d #d7a657 #9e9389 #2d4f67 #54433a'],
  'lucent-orng': ['transparent transparent transparent #eeeeee #808080 #ec5b2b #e06c75 #ec5b2b #6ba1e6 #c53b53 transparent transparent #eeeeee #ec5b2b #56b6c2 #6ba1e6 #fff7f1 #e5c07b #ee7948 #808080 #ec5b2b #eeeeee', 'transparent transparent transparent #1a1a1a #8a8a8a #ec5b2b #d1383d #ec5b2b #0062d1 #c53b53 transparent transparent #1a1a1a #ec5b2b #318795 #0062d1 #b0851f #b0851f #ec5b2b #8a8a8a #ec5b2b #1a1a1a'],
  'material': ['#263238 #1e272c #37474f #eeffff #546e7a #82aaff #f07178 #ffcb6b #c3e88d #f07178 #2e3c2b #3c2b2b #eeffff #82aaff #c792ea #c3e88d #546e7a #ffcb6b #ffcb6b #37474f #82aaff #eeffff', '#fafafa #f5f5f5 #e7e7e8 #263238 #90a4ae #6182b8 #e53935 #ffb300 #91b859 #e53935 #e8f5e9 #ffebee #263238 #6182b8 #7c4dff #91b859 #90a4ae #ffb300 #f4511e #e0e0e0 #6182b8 #263238'],
  'matrix': ['#0a0e0a #0e130d #141c12 #62ff94 #8ca391 #2eff6a #ff4b4b #e6ff57 #1cc24b #ff4b4b #132616 #261212 #62ff94 #00efff #24f6d9 #1cc24b #8ca391 #ffa83d #e6ff57 #8ca391 #30b3ff #62ff94', '#eef3ea #e4ebe1 #dae1d7 #203022 #748476 #1cc24b #ff4b4b #e6ff57 #1cc24b #ff4b4b #e0efde #f9e5e5 #203022 #24f6d9 #24f6d9 #1cc24b #748476 #ffa83d #e6ff57 #748476 #30b3ff #203022'],
  'mercury': ['#171721 #10101a #272735 #dddde5 #9d9da8 #8da4f5 #fc92b4 #fc9b6f #77c599 #fc92b4 #77c59933 #fc92b433 #dddde5 #ffffff #a7b6f8 #77c599 #9d9da8 #fc9b6f #f4f5f9 #b4b7c81f #ffffff #dddde5', '#ffffff #fbfcfd #f4f5f9 #363644 #70707d #5266eb #b0175f #a44200 #036e43 #b0175f #1885541a #d032751a #363644 #1e1e2a #5266eb #036e43 #70707d #a44200 #1e1e2a #7073931a #1e1e2a #363644'],
  'monokai': ['#272822 #1e1f1c #3e3d32 #f8f8f2 #75715e #66d9ef #f92672 #e6db74 #a6e22e #f92672 #1a3a1a #3a1a1a #f8f8f2 #f92672 #ae81ff #a6e22e #75715e #e6db74 #fd971f #75715e #66d9ef #f8f8f2', '#fafafa #f0f0f0 #e0e0e0 #272822 #75715e #66d9ef #f92672 #fd971f #a6e22e #f92672 #e0ffe0 #ffe0e0 #272822 #f92672 #ae81ff #a6e22e #75715e #fd971f #fd971f #75715e #66d9ef #272822'],
  'nightowl': ['#011627 #0b253a #0b253a #d6deeb #5f7e97 #82aaff #ef5350 #ecc48d #c5e478 #ef5350 #0a2e1a #2d1b1b #d6deeb #82aaff #82aaff #c5e478 #5f7e97 #c792ea #ecc48d #5f7e97 #82aaff #d6deeb', null],
  'nord': ['#2e3440 #3b4252 #434c5e #eceff4 #8b95a7 #88c0d0 #bf616a #d08770 #a3be8c #bf616a #3b4252 #3b4252 #d8dee9 #88c0d0 #8fbcbb #a3be8c #8b95a7 #d08770 #ebcb8b #8b95a7 #88c0d0 #d8dee9', '#eceff4 #e5e9f0 #d8dee9 #2e3440 #3b4252 #5e81ac #bf616a #d08770 #a3be8c #bf616a #e5e9f0 #e5e9f0 #2e3440 #5e81ac #8fbcbb #a3be8c #4c566a #d08770 #ebcb8b #4c566a #5e81ac #2e3440'],
  'one-dark': ['#282c34 #21252b #353b45 #abb2bf #5c6370 #61afef #e06c75 #e5c07b #98c379 #e06c75 #2c382b #3a2d2f #abb2bf #c678dd #56b6c2 #98c379 #5c6370 #e5c07b #d19a66 #5c6370 #61afef #abb2bf', '#fafafa #f0f0f1 #eaeaeb #383a42 #a0a1a7 #4078f2 #e45649 #c18401 #50a14f #e45649 #eafbe9 #fce9e8 #383a42 #a626a4 #0184bc #50a14f #a0a1a7 #c18401 #986801 #a0a1a7 #4078f2 #383a42'],
  'orng': ['#0a0a0a #141414 #1e1e1e #eeeeee #808080 #ec5b2b #e06c75 #ec5b2b #6ba1e6 #c53b53 #1a2a3d #37222c #eeeeee #ec5b2b #56b6c2 #6ba1e6 #fff7f1 #e5c07b #ee7948 #808080 #ec5b2b #eeeeee', '#ffffff #fff7f1 #f5f0eb #1a1a1a #8a8a8a #ec5b2b #d1383d #ec5b2b #0062d1 #c53b53 #e0edfa #f7d8db #1a1a1a #ec5b2b #318795 #0062d1 #b0851f #b0851f #ec5b2b #8a8a8a #ec5b2b #1a1a1a'],
  'osaka-jade': ['#111c18 #1a2520 #23372b #c1c497 #53685b #2dd5b7 #ff5345 #e5c736 #549e6a #ff5345 #15241c #241515 #c1c497 #2dd5b7 #549e6a #63b07a #53685b #d2689c #c1c497 #53685b #2dd5b7 #c1c497', '#f6f5dd #e8e7cc #d5d4b8 #111c18 #53685b #1faa90 #c7392d #b5a020 #3d7a52 #c7392d #e0eee5 #eee0e0 #111c18 #1faa90 #3d7a52 #3d7a52 #53685b #a8527a #111c18 #53685b #1faa90 #111c18'],
  'palenight': ['#292d3e #1e2132 #32364a #a6accd #676e95 #82aaff #f07178 #ffcb6b #c3e88d #f07178 #2e3c2b #3c2b2b #a6accd #c792ea #89ddff #c3e88d #676e95 #ffcb6b #f78c6c #676e95 #82aaff #a6accd', '#fafafa #f5f5f5 #e7e7e8 #292d3e #8796b0 #4976eb #e53935 #ffb300 #91b859 #e53935 #e8f5e9 #ffebee #292d3e #a854f2 #00acc1 #91b859 #8796b0 #ffb300 #f4511e #8796b0 #4976eb #292d3e'],
  'rosepine': ['#191724 #1f1d2e #26233a #e0def4 #6e6a86 #9ccfd8 #eb6f92 #f6c177 #31748f #eb6f92 #1f2d3a #3a1f2d #e0def4 #c4a7e7 #ebbcba #31748f #6e6a86 #f6c177 #eb6f92 #403d52 #9ccfd8 #e0def4', '#faf4ed #fffaf3 #f2e9e1 #575279 #9893a5 #31748f #b4637a #ea9d34 #286983 #b4637a #e5f2f3 #fce5e8 #575279 #907aa9 #d7827e #286983 #9893a5 #ea9d34 #b4637a #dfdad9 #31748f #575279'],
  'solarized': ['#002b36 #073642 #073642 #839496 #586e75 #268bd2 #dc322f #b58900 #859900 #dc322f #073642 #073642 #839496 #268bd2 #6c71c4 #859900 #586e75 #b58900 #cb4b16 #586e75 #268bd2 #839496', '#fdf6e3 #eee8d5 #eee8d5 #657b83 #93a1a1 #268bd2 #dc322f #b58900 #859900 #dc322f #eee8d5 #eee8d5 #657b83 #268bd2 #6c71c4 #859900 #93a1a1 #b58900 #cb4b16 #93a1a1 #268bd2 #657b83'],
  'synthwave84': ['#262335 #1e1a29 #2a2139 #ffffff #848bbd #36f9f6 #fe4450 #fede5d #72f1b8 #fe4450 #1a3a2a #3a1a2a #ffffff #ff7edb #b084eb #72f1b8 #848bbd #fede5d #ff8b39 #495495 #36f9f6 #ffffff', '#fafafa #f5f5f5 #eeeeee #262335 #5c5c8a #00bcd4 #f44336 #ff9800 #4caf50 #f44336 #e8f5e9 #ffebee #262335 #e91e63 #9c27b0 #4caf50 #5c5c8a #ff9800 #ff5722 #e0e0e0 #00bcd4 #262335'],
  'tokyonight': ['#1a1b26 #1e2030 #222436 #c8d3f5 #828bb8 #82aaff #ff757f #ff966c #4fd6be #c53b53 #20303b #37222c #c8d3f5 #c099ff #86e1fc #c3e88d #ffc777 #ffc777 #ff966c #828bb8 #82aaff #c8d3f5', '#e1e2e7 #d5d6db #c8c9ce #3760bf #8990a3 #2e7de9 #f52a65 #b15c00 #1e725c #c53b53 #d5e5d5 #f7d8db #3760bf #9854f1 #007197 #587539 #8c6c3e #8c6c3e #b15c00 #8990a3 #2e7de9 #3760bf'],
  'vercel': ['#000000 #1a1a1a #292929 #ededed #878787 #0070f3 #e5484d #ffb224 #63c46d #ff6166 #0b1d0f #2a1314 #ededed #bf7af0 #0ac7ac #63c46d #878787 #f2a700 #f75590 #454545 #ededed #ededed', '#ffffff #fafafa #eaeaea #171717 #666666 #0070f3 #dc3545 #ff9500 #46a758 #e5484d #e6f9e9 #fdeced #171717 #8e4ec6 #12a594 #46a758 #666666 #ffb224 #e93d82 #999999 #171717 #171717'],
  'vesper': ['#101010 #101010 #101010 #ffffff #a0a0a0 #ffc799 #ff8080 #ffc799 #99ffe4 #ff8080 #0d2818 #281a1a #ffffff #ffc799 #a0a0a0 #a0a0a0 #ffffff #ffffff #ffffff #65737e #ffffff #ffffff', '#ffffff #f0f0f0 #e0e0e0 #101010 #a0a0a0 #ffc799 #ff8080 #ffc799 #99ffe4 #ff8080 #e8f5e8 #f5e8e8 #101010 #ffc799 #a0a0a0 #a0a0a0 #101010 #101010 #101010 #65737e #101010 #101010'],
  'zenburn': ['#3f3f3f #4f4f4f #5f5f5f #dcdccc #9f9f9f #8cd0d3 #cc9393 #f0dfaf #7f9f7f #cc9393 #4f5f4f #5f4f4f #dcdccc #f0dfaf #93e0e3 #7f9f7f #9f9f9f #e0cf9f #dfaf8f #9f9f9f #8cd0d3 #dcdccc', '#ffffef #f5f5e5 #ebebdb #3f3f3f #6f6f6f #5f7f8f #8f5f5f #8f8f5f #5f8f5f #8f5f5f #efffef #ffefef #3f3f3f #8f8f5f #5f8f8f #5f8f5f #6f6f6f #8f8f5f #8f7f5f #6f6f6f #5f7f8f #3f3f3f'],
};

export const DEFAULT = 'omonitor';
export const NAMES = [DEFAULT, ...Object.keys(THEMES)];
// omonitor's own surfaces and swatch colors, mirrored from its .mc rules.
const OWN = {
  dark: { bg: '#161618', panel: '#1c1c1f', element: '#222225', dots: ['#94bce3', '#9d7cd8', '#f5a742', '#7fd88f'] },
  light: { bg: '#fcfcfc', panel: '#f5f5f6', element: '#ffffff', dots: ['#5980a6', '#b45309', '#b45309', '#1a7f37'] },
};

// 'dark' or 'light' for a theme that has only that mode, '' for omonitor and two-mode themes.
export function onlyMode(name) {
  const t = THEMES[name];
  return !t ? '' : !t[1] ? 'dark' : !t[0] ? 'light' : '';
}

// The mode a theme shows in: its only one when it has one (opencode does the same), else the chosen mode, where
// 'system' follows the device.
export function schemeOf(name, mode, systemDark) {
  return onlyMode(name) || (mode === 'system' ? (systemDark ? 'dark' : 'light') : mode === 'light' ? 'light' : 'dark');
}

function colors(name, scheme) {
  const raw = THEMES[name][scheme === 'light' ? 1 : 0].split(' ');
  const c = Object.fromEntries(COLS.map((k, i) => [k, raw[i]]));
  // lucent-orng leaves its surfaces transparent so the terminal shows through; omonitor's own surfaces stand in.
  for (const k of ['bg', 'panel', 'element']) if (c[k] === 'transparent') c[k] = OWN[scheme][k];
  return c;
}

// The picker's preview chip: the background with the accent, heading, bold and code colors on it.
export function swatch(name, scheme) {
  if (!THEMES[name]) return { bg: OWN[scheme].bg, dots: OWN[scheme].dots };
  const c = colors(name, scheme);
  return { bg: c.bg, dots: [c.primary, c.mdHeading, c.mdStrong, c.mdCode] };
}

// WCAG relative luminance and contrast, to pick the text color that reads on an accent or warning fill.
const luminance = (hex) => {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const ink = (fill, c) => (contrast(fill, c.bg) >= contrast(fill, c.text) ? c.bg : c.text);

// CSS for a theme in a mode: the omonitor variables on .mc (the class three times: .mc[data-theme="light"] weighs two,
// and the page's own sheet may land after this one, which the cached theme paints first) and the page background, plus the color for <meta name="theme-color">. Lines, tints and
// hovers are the text color at omonitor's own strengths, so every theme keeps the same flat look; surfaces, accent,
// status, diff and markdown colors are the theme's.
export function themeCss(name, scheme) {
  if (!THEMES[name]) {
    const bg = OWN[scheme].bg;
    return { css: `:root,:root body{background:${bg}}`, bg };
  }
  const c = colors(name, scheme), fg = c.text, p = c.primary, light = scheme === 'light';
  const a = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;
  const mix = (x, pct, y) => `color-mix(in oklab, ${x} ${pct}%, ${y})`;
  // A theme whose panels match its background (vesper) would leave cards and popovers invisible on it.
  const raised = (v, pct) => (v === c.bg ? mix(fg, pct, c.bg) : v);
  const vars = {
    bg: c.bg, side: c.panel, card: raised(c.panel, 4), bg2: raised(c.element, 7),
    sel: a(fg, light ? 7 : 8), seg: light ? mix(c.bg, 40, '#fff') : a(fg, 10), msg: a(fg, light ? 5 : 6),
    fg, fg2: mix(fg, 55, c.muted), fg3: c.muted,
    line: a(fg, light ? 10 : 9), 'line-soft': a(fg, 6), line2: a(fg, light ? 15 : 13), line3: a(fg, light ? 26 : 22), hover: a(fg, 4.5), tint: a(fg, 3.5),
    acc: p, 'acc-fg': mix(p, 82, fg), 'acc-tint': a(p, 16), 'on-acc': ink(p, c),
    warn: c.warning, 'warn-line': a(c.warning, 32), 'warn-tint': a(c.warning, light ? 14 : 8), 'on-warn': ink(c.warning, c),
    err: c.error, 'err-fg': mix(c.error, 80, fg), 'err-line': a(c.error, 40), 'err-tint': a(c.error, light ? 8 : 10),
    idle: c.muted, arch: mix(c.muted, 55, c.bg),
    'add-fg': c.added, 'add-bg': c.addedBg === 'transparent' ? a(c.added, 12) : c.addedBg,
    'del-fg': c.removed, 'del-bg': c.removedBg === 'transparent' ? a(c.removed, 12) : c.removedBg,
    'color-bg': c.bg, 'color-text': fg, 'color-surface': a(fg, 4), 'color-accent': p, 'color-accent-600': mix(p, 85, fg), 'color-accent-700': mix(p, 70, fg), 'color-divider': a(fg, light ? 14 : 10),
    'md-text': c.mdText, 'md-heading': c.mdHeading, 'md-strong': c.mdStrong, 'md-emph': c.mdEmph, 'md-code': c.mdCode, 'md-codeblock': c.mdCodeBlock,
    'md-codeblock-bg': a(fg, 3), 'md-link': c.mdLink, 'md-quote': c.mdQuote, 'md-hr': c.mdHr, 'md-bullet': c.mdList,
  };
  return { css: `.mc.mc.mc{${Object.entries(vars).map(([k, v]) => `--${k}:${v}`).join(';')}}:root,:root body{background:${c.bg}}`, bg: c.bg };
}
