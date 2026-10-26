/** @type {import('next').NextConfig} */
const config = {
  async rewrites() {
    return {
      beforeFiles:
        process.env.VERCEL === '1'
          ? [
              {
                source: '/api/:path*',
                destination: 'https://dispatch-ololade-demo.eastus.cloudapp.azure.com/api/:path*'
              }
            ]
          : [],
      afterFiles: [],
      fallback: []
    };
  }
};

export default config;
