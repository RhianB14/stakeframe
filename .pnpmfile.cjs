// Better Auth's optional CLI/test integrations are unused by this application.
// Avoid carrying workspace development tools into its production dependency graph.
module.exports = {
  hooks: {
    readPackage(manifest) {
      if (manifest.name === 'better-auth' && manifest.version === '1.7.3') {
        for (const name of ['drizzle-kit', 'vitest']) {
          if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
            throw new Error(`Expected an optional Better Auth peer: ${name}`);
          }
          delete manifest.peerDependencies[name];
          delete manifest.peerDependenciesMeta[name];
        }
      }
      return manifest;
    },
  },
};
