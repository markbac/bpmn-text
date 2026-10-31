# syntax=docker/dockerfile:1
# Two images from one build (docs/deployment.md):
#
#   docker build --target editor -t bpmn-text-editor .   the web editor, served by nginx
#   docker build --target cli -t bpmn-text .              the command line, with Chromium
#                                                         for SVG and PNG output
#
# Behind a TLS-inspecting proxy, pass its certificate as a build secret:
# --secret id=ca,src=proxy-ca.pem (the update scripts' --ca-file).

# Build: every package, the editor bundle and the CLI tarball.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY . .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi \
 && npm ci --no-audit --no-fund \
 && npm run build \
 && npm run release:pack -- --cli-only

# The web editor: static files, so plain nginx.
FROM nginx:1.29-alpine AS editor
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/editor/dist /usr/share/nginx/html
EXPOSE 80

# The command line: `docker run --rm -v "$PWD:/work" bpmn-text build x.bpmnt`.
FROM node:22-bookworm-slim AS cli
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY --from=build /src/release/bpmn-text-*.tgz /tmp/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi \
 && npm install -g --no-audit --no-fund /tmp/bpmn-text-*.tgz \
 && rm /tmp/bpmn-text-*.tgz \
 && node "$(npm root -g)/bpmn-text/node_modules/playwright-core/cli.js" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /opt/playwright
USER node
WORKDIR /work
ENTRYPOINT ["bpmn-text"]
CMD ["--help"]
