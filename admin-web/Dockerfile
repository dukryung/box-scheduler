# Built from the repository root so the shared theme (shared/) is in the context.
FROM node:22-alpine AS build
WORKDIR /app/admin-web
COPY admin-web/package.json admin-web/package-lock.json ./
RUN npm ci
COPY shared /app/shared
COPY admin-web/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY admin-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/admin-web/dist /usr/share/nginx/html
