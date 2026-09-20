/// <reference lib="dom" />
// zustand StateStorage 在 renderer 运行；根 tsconfig 程序（electron 引入本文件）lib 无 DOM，
// 按文件级引入 lib.dom 仅为 window.localStorage 提供类型（不改变运行时行为）。
import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "shotshot",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
