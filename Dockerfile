FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY compare.js /usr/share/nginx/html/compare.js
COPY compare-fix.js /usr/share/nginx/html/compare-fix.js
COPY terrain-change.js /usr/share/nginx/html/terrain-change.js
COPY imagery-filter.js /usr/share/nginx/html/imagery-filter.js
COPY research-scope.js /usr/share/nginx/html/research-scope.js
COPY branding.js /usr/share/nginx/html/branding.js
COPY view-state.js /usr/share/nginx/html/view-state.js
COPY layout.js /usr/share/nginx/html/layout.js
COPY data /usr/share/nginx/html/data

# Keep client-side research modules directly readable by the unprivileged nginx worker.
RUN chmod 644 /usr/share/nginx/html/index.html /usr/share/nginx/html/compare.js /usr/share/nginx/html/compare-fix.js /usr/share/nginx/html/terrain-change.js /usr/share/nginx/html/imagery-filter.js /usr/share/nginx/html/research-scope.js /usr/share/nginx/html/branding.js /usr/share/nginx/html/view-state.js /usr/share/nginx/html/layout.js \
    && find /usr/share/nginx/html/data -type d -exec chmod 755 {} \; \
    && find /usr/share/nginx/html/data -type f -exec chmod 644 {} \;

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1
