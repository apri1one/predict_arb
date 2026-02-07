module.exports = {
    apps: [
        {
            name: "dashboard",
            cwd: __dirname,
            script: "node_modules/tsx/dist/cli.cjs",
            args: "src/dashboard/start-dashboard.ts",
            interpreter: "node",
            windowsHide: true
        }
    ]
};
