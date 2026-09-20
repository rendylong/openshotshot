import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

import { palette } from "./design/palette";

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const s = palette.stone;
    const st = palette.status;
    const itemHoverBg = dark ? "rgba(250, 250, 249, 0.08)" : "rgba(28, 25, 23, 0.06)";
    const itemSelectedBg = dark ? "rgba(250, 250, 249, 0.12)" : "rgba(28, 25, 23, 0.1)";
    const itemSelectedHoverBg = dark ? "rgba(250, 250, 249, 0.16)" : "rgba(28, 25, 23, 0.14)";
    const itemText = dark ? s[50] : s[900];
    const tableSelectedBg = dark ? "rgba(255, 255, 255, 0.08)" : "rgba(28, 25, 23, 0.05)";
    const tableSelectedHoverBg = dark ? "rgba(255, 255, 255, 0.12)" : "rgba(28, 25, 23, 0.08)";

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "shotshot-dark" : "shotshot-light" },
        token: {
            zIndexPopupBase: 2000,
            controlHeight: 32,
            borderRadius: 8,
            borderRadiusLG: 18,
            colorPrimary: dark ? s[50] : s[900],
            colorInfo: dark ? st.infoDark : st.infoLight,
            colorLink: dark ? s[50] : s[900],
            colorLinkHover: dark ? s[50] : s[900],
            colorLinkActive: dark ? s[50] : s[900],
            colorError: dark ? st.dangerDark : st.dangerLight,
            colorWarning: dark ? st.warningDark : st.warningLight,
            colorSuccess: dark ? st.successDark : st.successLight,
            colorTextLightSolid: dark ? s[900] : s[50],
            colorBgElevated: dark ? s[800] : "#ffffff",
            boxShadowSecondary: dark ? "0 18px 48px rgba(0, 0, 0, 0.42)" : "0 18px 48px rgba(28, 25, 23, 0.14)",
            controlItemBgHover: itemHoverBg,
            controlItemBgActive: itemSelectedBg,
            controlItemBgActiveHover: itemSelectedHoverBg,
        },
        components: {
            Button: { primaryShadow: "none" },
            Dropdown: { colorBgElevated: dark ? s[800] : "#ffffff", colorText: itemText, controlItemBgHover: itemHoverBg, controlItemBgActive: itemSelectedBg, controlItemBgActiveHover: itemSelectedHoverBg },
            Menu: { popupBg: dark ? s[800] : "#ffffff", itemActiveBg: itemSelectedBg, itemHoverBg: itemHoverBg, itemSelectedBg: itemSelectedBg, itemSelectedColor: itemText, darkPopupBg: s[800], darkItemHoverBg: itemHoverBg, darkItemSelectedBg: itemSelectedBg, darkItemSelectedColor: itemText },
            Select: { optionActiveBg: itemHoverBg, optionSelectedBg: itemSelectedBg, optionSelectedColor: itemText },
            Table: { rowSelectedBg: tableSelectedBg, rowSelectedHoverBg: tableSelectedHoverBg },
        },
    };
}
