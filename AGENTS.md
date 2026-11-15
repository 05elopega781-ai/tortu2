# Versionado antes de publicar

Antes de cada `git push`:

1. Incrementa el numero patch de `package.json` y `package-lock.json` con `npm version patch --no-git-tag-version` (por ejemplo, `1.0.0` a `1.0.1`).
2. Incluye el cambio de versión en el commit que vas a publicar.
3. Crea una etiqueta anotada `v<version>` en ese commit y publica tanto la rama como la etiqueta.

Incrementa una sola vez por cada push, verifica que la etiqueta no exista y no reutilices una versión publicada.
El overlay muestra esta version desde `package.json`; no fijes la etiqueta visual a mano en el HTML.
