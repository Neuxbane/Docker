Add Service UI

Summary:
- The console UI now supports adding a new service to a project from the Edit modal.
- You can set: name, docker image, ports, volumes, and environment variables.

How it works:
- Open a project -> Edit. Click "Add Service".
- Fill the service name and optional image, ports (host:container or container), volumes (host:container), and environment entries.
- The new service is added locally in the editor. Click "Apply changes" to persist the change.

Backend:
- The `/api/apply` endpoint accepts the following for each service:
  { name: { image?: string, ports?: string[], volumes?: string[], environment?: string[]|object, networks?: object } }
- When saved, the server writes the fields into the service object inside `docker-compose.yml` and runs a scan to rebuild `mapper.json`.

Notes:
- Service names must be unique within the project.
- The UI adds the service to the compose file; you may need to review `apps/<project>/docker-compose.yml` for additional settings (command, entrypoint, etc).
- When providing environment as an array, use `KEY=VALUE` form; as an object, provide { KEY: VALUE }.

