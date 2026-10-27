/** @type {import('next').NextConfig} */
const config = {
  // Runtime data is mounted separately; private workspace files must never enter server traces.
  outputFileTracingExcludes: {
    '/*': [
      './.local/**/*',
      './.desloppify/**/*',
      './AGENTS.md',
      './PRD.md',
      './ARCHITECTURE.md',
      './DESIGN.md',
      './RULES.md',
      './TASKS.md',
      './PROGRESS.md',
      './.env*',
      './data/**/*',
      './db/data/**/*',
      './tests/.tmp/**/*',
      './*.{key,pem,sqlite,sqlite3,db,bak,backup,dmg,webp}'
    ]
  },
  turbopack: {
    resolveAlias: {
      // The vendored reference stays unedited and is compiled by Turbopack at runtime.
      '@meterless/world-model-reference': './vendor/meterless/world-model/reference/src/index.ts'
    }
  },
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
