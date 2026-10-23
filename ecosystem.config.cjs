module.exports = {
  apps: [
    {
      name: "harvey-verify",
      script: "dist/index.js",
      cwd: "/home/deploy/projects/harvey-verify",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: 8404,
      },
      max_memory_restart: "256M",
      // Longer than the 90 s shutdown grace (src/lib/graceful-shutdown.ts), so a stop
      // or restart lets paid calls in flight finish instead of killing them at 1.6 s.
      kill_timeout: 100000,
      autorestart: true,
      watch: false,
    },
  ],
};
