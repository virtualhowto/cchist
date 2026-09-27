FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY compare.js /usr/share/nginx/html/compare.js
COPY view-state.js /usr/share/nginx/html/view-state.js
COPY data /usr/share/nginx/html/data

RUN chmod 644 /usr/share/nginx/html/index.html /usr/share/nginx/html/compare.js /usr/share/nginx/html/view-state.js \
    && find /usr/share/nginx/html/data -type d -exec chmod 755 {} \; \
    && find /usr/share/nginx/html/data -type f -exec chmod 644 {} \;

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
