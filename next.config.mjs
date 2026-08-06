/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Linting is run separately; don't fail production builds on lint.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
