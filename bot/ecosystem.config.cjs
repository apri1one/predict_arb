module.exports = {
    apps: [
        {
            name: "dashboard",
            cwd: __dirname,
            script: process.platform === 'win32'
                ? "node_modules/tsx/dist/cli.cjs"
                : "start.sh",
            args: process.platform === 'win32'
                ? "src/dashboard/start-dashboard.ts"
                : "",
            interpreter: process.platform === 'win32'
                ? "node"
                : "bash",
            windowsHide: true,
            env: {
                AWS_SECRET_ID: "predict-engine/bot/env"
            }
        }
    ]
};
