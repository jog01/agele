import type { Container } from "./container";
import type { AuthClaims } from "./services/auth.service";

export type AppEnv = {
  Variables: {
    requestId: string;
    container: Container;
    auth: AuthClaims;
  };
};
