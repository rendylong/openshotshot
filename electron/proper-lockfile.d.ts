declare module "proper-lockfile" {
    const lockfile: { lock(path: string): Promise<() => Promise<void>> };
    export default lockfile;
}
