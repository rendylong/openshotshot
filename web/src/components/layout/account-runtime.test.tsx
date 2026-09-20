import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AccountRuntime } from "./account-runtime";
import { useUserStore } from "@/stores/use-user-store";

afterEach(() => {
    useUserStore.getState().dispose();
    delete window.shotshot;
});

describe("AccountRuntime", () => {
    test("initializes once and disposes with the app boundary", async () => {
        const initialize = vi.spyOn(useUserStore.getState(), "initialize");
        const dispose = vi.spyOn(useUserStore.getState(), "dispose");
        const view = render(<AccountRuntime />);
        await waitFor(() => expect(initialize).toHaveBeenCalledOnce());
        view.unmount();
        expect(dispose).toHaveBeenCalledOnce();
    });
});
