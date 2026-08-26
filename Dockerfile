# ================================================================
# yadinstore-jenkins-obs-live — Zero-deps Node HTTP (server.js)
# Runtime: node:20-alpine (solo `node: http/fs/crypto`, sin deps)
# PR-2 MEDIUM M4: pin digest supply-chain (SLSA)
# ================================================================
# node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 (verificado 2026-08-26)
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
COPY server.js jenkins-dashboard.html ./
# No npm install — zero-deps (solo módulos nativos http/fs/crypto/path)
EXPOSE 3000
CMD ["node", "server.js"]
