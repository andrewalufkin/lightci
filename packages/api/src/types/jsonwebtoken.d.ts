declare module 'jsonwebtoken' {
  interface VerifyOptions {
    algorithms?: string[];
    audience?: string | string[];
    clockTimestamp?: number;
    clockTolerance?: number;
    complete?: boolean;
    issuer?: string | string[];
    jwtid?: string;
    nonce?: string;
    subject?: string;
    maxAge?: string | number;
    ignoreExpiration?: boolean;
    ignoreNotBefore?: boolean;
  }

  interface SignOptions {
    algorithm?: string;
    expiresIn?: string | number;
    notBefore?: string | number;
    audience?: string | string[];
    issuer?: string;
    jwtid?: string;
    subject?: string;
    noTimestamp?: boolean;
    header?: object;
    keyid?: string;
    mutatePayload?: boolean;
  }

  function sign(
    payload: string | Buffer | object,
    secretOrPrivateKey: string | Buffer,
    options?: SignOptions
  ): string;

  function verify<T = any>(
    token: string,
    secretOrPublicKey: string | Buffer,
    options?: VerifyOptions
  ): T;

  const jwt: {
    sign: typeof sign;
    verify: typeof verify;
  };

  export = jwt;
} 