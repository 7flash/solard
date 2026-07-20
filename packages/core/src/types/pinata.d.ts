declare module "pinata" {
  export class PinataSDK {
    constructor(options: { pinataJwt: string; pinataGateway?: string });
    upload: {
      public: {
        file(file: File): { name(name: string): Promise<{ cid: string }> };
        json(value: unknown): { name(name: string): Promise<{ cid: string }> };
      };
    };
  }
}
