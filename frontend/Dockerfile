FROM nginx:stable-alpine
COPY index.html styles.css app.jsx /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80