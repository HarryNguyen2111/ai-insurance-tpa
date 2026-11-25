# Test-only stock upstream PgBouncer, ISC license (COPYRIGHT retained).
FROM alpine:3.23.2@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62 AS build
RUN apk add --no-cache build-base libevent-dev openssl-dev curl
WORKDIR /build
RUN curl -fsSLO https://www.pgbouncer.org/downloads/files/1.26.1/pgbouncer-1.26.1.tar.gz \
 && echo '00886a2994b4844cd37110970df777772cfc42a74c400522c82fba509a3f42d9  pgbouncer-1.26.1.tar.gz' | sha256sum -c - \
 && tar -xzf pgbouncer-1.26.1.tar.gz
WORKDIR /build/pgbouncer-1.26.1
RUN ./configure --prefix=/usr/local --with-pam=no && make -j1 pgbouncer
FROM alpine:3.23.2@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62
RUN apk add --no-cache libevent openssl && adduser -D -u 10001 pooler
COPY --from=build /build/pgbouncer-1.26.1/pgbouncer /usr/local/bin/pgbouncer
COPY --from=build /build/pgbouncer-1.26.1/COPYRIGHT /usr/share/licenses/pgbouncer/COPYRIGHT
USER 10001
ENTRYPOINT ["/usr/local/bin/pgbouncer"]
CMD ["/config/pgbouncer.ini"]
