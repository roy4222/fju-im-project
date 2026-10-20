/** 只宣告載入函式；是否下載由頁首的互動與 media-query 條件決定。 */
export const loadBrokenFx = () => import('@/app/_ui/fx/fuzzy-engine')
export const loadHomePixel = () => import('@/app/_ui/fx/home-hero-pixel')
export const loadFlyingButton = () => import('@/app/_ui/fx/flying-button')
export const loadStaggeredMenu = () => import('@/app/_ui/staggered-menu')
export const loadEasterEgg = () => import('@/app/_ui/easter-egg')
export const loadPixelMedia = () => import('@/app/_ui/fx/media-query')
