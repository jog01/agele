import type { Container } from "./container";
import type { AuthClaims } from "./services/auth.service";

export type AppEnv = {
  Bindings: { clientIp?: string };
  Variables: {
    requestId: string;
    container: Container;
    auth: AuthClaims;
  };
};
