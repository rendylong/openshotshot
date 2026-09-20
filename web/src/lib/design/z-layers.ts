/** 全站 z-index 阶梯（spec §4.8）。新浮层查表取值，禁止裸数值。 */
export const Z_LAYERS = {
    titlebar: 40,
    panelSlot: 70,
    surfaceMax: 120,
    canvasTop: 1100,
    canvasOverlay: 1200,
    dialog: 1900,
    antdPopup: 2000,
    dropdown: 2100,
} as const;
