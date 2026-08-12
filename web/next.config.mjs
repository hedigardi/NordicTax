import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== "production";

const nextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: __dirname,
  distDir: isDev ? ".next-dev" : ".next",
  webpack: (config, { dev }) => {
    if (dev) {
      config.cache = false;
    }

    return config;
  },
};

export default nextConfig;
