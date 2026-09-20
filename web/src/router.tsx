import { createBrowserRouter, createHashRouter, Navigate, Outlet, useParams } from "react-router-dom";

import UserLayout from "@/layouts/user-layout";
import CanvasProjectPage from "@/pages/canvas/project";
import HomePage from "@/pages/home";
import NotFound from "@/pages/not-found";
import ProjectDetailPage from "@/pages/projects/detail";
import ProjectsPage from "@/pages/projects";
import SkillsPage from "@/pages/skills";

// 桌面端（Electron 经 preload 注入 window.shotshot）用 file:// 加载，
// BrowserRouter 会把 window.location.pathname（asar 里的文件路径）当路由去匹配，
// 落到 `*` 的 404 页。改用 hash 路由，路径与文件位置解耦；Web 端保持 BrowserRouter 不变。
const isElectron = typeof window !== "undefined" && Boolean(window.shotshot);
const createRouter = isElectron ? createHashRouter : createBrowserRouter;

// Legacy single-segment canvas URLs (/canvas/:projectId) redirect to the project
// detail page now that the canvas route requires both project and canvas ids.
function CanvasLegacyRedirect() {
    const { projectId } = useParams();
    return <Navigate to={`/projects/${projectId}`} replace />;
}

export const router = createRouter([
    {
        element: (
            <UserLayout>
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/skills", element: <SkillsPage /> },
            { path: "/projects", element: <ProjectsPage /> },
            { path: "/projects/:projectId", element: <ProjectDetailPage /> },
            { path: "/canvas/:projectId/:canvasId", element: <CanvasProjectPage /> },
            { path: "/canvas/:projectId", element: <CanvasLegacyRedirect /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
