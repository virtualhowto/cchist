# Deployment workflows

`deploy-swarm.yml` is the production deployment workflow for `cchist.virtualhowto.com`.

It targets the self-hosted runner labelled `ourimbah`, verifies that the runner is on a Swarm manager, builds the site image, deploys the `cchist` Swarm stack, waits for `cchist_cchist` to reach `1/1`, and accepts an Authentik redirect or HTTP 200 from the public endpoint.

Any older Compose-based deployment workflow should remain disabled or be removed; production is Swarm-only.
