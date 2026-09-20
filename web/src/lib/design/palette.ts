/** TS 侧唯一色板常量。仅允许 canvas 2d 绘制、antd token、测试取值；
 *  DOM 样式一律用 globals.css 的 CSS 变量，禁止把这里的值写进组件内联样式（spec §4.1）。 */
export const palette = {
    stone: {
        50: "#fafaf9",
        100: "#f5f5f4",
        200: "#e7e5e4",
        300: "#d6d3d1",
        400: "#a8a29e",
        500: "#78716c",
        600: "#57534e",
        700: "#44403c",
        800: "#292524",
        900: "#1c1917",
        950: "#0c0a09",
    },
    status: {
        dangerLight: "#dc2626",
        dangerDark: "#f87171",
        warningLight: "#b45309",
        warningDark: "#fbbf24",
        successLight: "#15803d",
        successDark: "#4ade80",
        infoLight: "#2563eb",
        infoDark: "#60a5fa",
    },
    canvas: {
        surfaceLight: "rgba(255,255,255,.96)",
        surfaceDark: "rgba(31,29,26,.96)",
        dotLight: "rgba(68,64,60,.28)",
        dotDark: "rgba(245,245,244,.24)",
    },
} as const;
