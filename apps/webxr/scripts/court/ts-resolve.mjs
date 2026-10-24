// Lets node --test load browser modules that import their siblings the bundler's way ("./annexb", no extension):
// a resolve hook that retries a relative, extensionless specifier with ".ts". Import this first, then import the
// module under test dynamically (static imports are all resolved before any module runs).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});
