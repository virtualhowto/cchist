# Swarm deployment

The site is deployed as the Docker Swarm stack `cchist` and published through Traefik at:

- https://cchist.virtualhowto.com

## Prerequisites

- Docker Swarm is initialised.
- The `ourimbah` GitHub Actions runner is on a Swarm manager node, or otherwise has access to a manager Docker socket/context.
- External overlay network `t3_proxy` exists and is attachable to Traefik, Authentik outpost and this service.
- Traefik is configured with the Docker Swarm provider and the `websecure` entrypoint.
- Authentik proxy outpost is attached to `t3_proxy`.

Create the overlay network if required:

```bash
docker network create --driver overlay --attachable t3_proxy
```

## Authentik

Create an Authentik Proxy Provider/Application for `https://cchist.virtualhowto.com` using forward-auth / single-application mode.

`docker-stack.yml` currently expects the outpost service to resolve as:

```text
authentik-proxy-outpost:9000
```

If your existing outpost has a different Swarm service DNS name, change the `cchist-auth.forwardauth.address` label before deployment.

## Manual deployment

Build the image on a Swarm node and deploy the stack:

```bash
docker build -t cchist:latest .
docker stack deploy -c docker-stack.yml cchist
```

Check it with:

```bash
docker stack services cchist
docker service ps cchist_cchist
docker service logs -f cchist_cchist
```

> A locally-built image works reliably only when the service is constrained to the node holding that image, or when every eligible Swarm node has that image. For a multi-node production Swarm, publish the image to a registry and use an immutable tag such as the Git commit SHA.
