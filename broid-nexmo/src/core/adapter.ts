import * as Promise from "bluebird";
import broidSchemas from "broid-schemas";
import { Logger } from "broid-utils";
import { EventEmitter } from "events";
import { Router } from "express";
import * as Nexmo from "nexmo";
import * as uuid from "node-uuid";
import * as R from "ramda";
import { Observable } from "rxjs/Rx";

import { IAdapterOptions } from "./interfaces";
import Parser from "./parser";
import WebHookServer from "./webHookServer";

export default class Adapter {
  private serviceID: string;
  private username: string | null;
  private token: string | null;
  private tokenSecret: string | null;
  private connected: boolean;
  private parser: Parser;
  private logLevel: string;
  private logger: Logger;
  private webhookServer: WebHookServer;
  private session: any;
  private emitter: EventEmitter;
  private router: Router;

  constructor(obj: IAdapterOptions) {
    this.serviceID = obj && obj.serviceID || uuid.v4();
    this.logLevel = obj && obj.logLevel || "info";
    this.token = obj && obj.token || null;
    this.tokenSecret = obj && obj.tokenSecret || null;
    this.username = obj && obj.username || null;

    this.parser = new Parser(this.serviceName(), this.serviceID, this.logLevel);
    this.logger = new Logger("adapter", this.logLevel);

    this.emitter = new EventEmitter();
    this.router = this.setupRouter();

    if (obj.http) {
      this.webhookServer = new WebHookServer(obj.http, this.router, this.logLevel);
    }
  }

  // Return list of users information
  public users(): Promise<Error> {
    return Promise.reject(new Error("Not supported"));
  }

  // Return list of channels information
  public channels(): Promise<Error> {
    return Promise.reject(new Error("Not supported"));
  }

  // Return the service ID of the current instance
  public serviceId(): String {
    return this.serviceID;
  }

  public getRouter(): Router | null {
    if (this.webhookServer) {
      return null;
    }
    return this.router;
  }

  public serviceName(): string {
    return "nexmo";
  }

  // Connect to Nexmo
  // Start the webhook server
  public connect(): Observable<Object> {
    if (this.connected) {
      return Observable.of({ type: "connected", serviceID: this.serviceId() });
    }
    this.connected = true;

    if (!this.token || this.token === "") {
      return Observable.throw(new Error("Token should exist."));
    }

    if (!this.tokenSecret || this.tokenSecret === "") {
      return Observable.throw(new Error("TokenSecret should exist."));
    }

    this.session = new Nexmo({
      apiKey: this.token,
      apiSecret: this.tokenSecret,
    });

    if (this.webhookServer) {
      this.webhookServer.listen();
    }

    return Observable.of(({ type: "connected", serviceID: this.serviceId() }));
  }

  public disconnect(): Promise<Error> {
    return Promise.reject(new Error("Not supported"));
  }

  // Listen "message" event from Nexmo
  public listen(): Observable<Object> {
    if (!this.webhookServer) {
      return Observable.throw(new Error("No webhookServer found."));
    }

    return Observable.fromEvent(this.emitter, "message")
      .mergeMap((normalized: any) =>
        this.parser.parse(normalized))
      .mergeMap((parsed) => this.parser.validate(parsed))
      .mergeMap((validated) => {
        if (!validated) { return Observable.empty(); }
        return Promise.resolve(validated);
      });
  }

  public send(data: any): Promise<Object | Error> {
    this.logger.debug("sending", { message: data });
    return broidSchemas(data, "send")
      .then(() => {
        if (data.object.type !== "Note") {
          return Promise.reject(new Error("Only Note is supported."));
        }

        return Promise.resolve(data)
          .then((result: any) => {
            const toNumber = R.path(["to", "id"], result);
            const content = R.path(["object", "content"], result);
            return Promise.fromCallback((cb) =>
              this.session.message.sendSms(this.username, toNumber, content, {}, cb));
          })
          .then((result) => {
            const ids = R.map((message) => message["message-id"], result.messages);
            return { type: "sent", serviceID: this.serviceId(), ids };
          });
      });
  }

  private setupRouter(): Router {
    const router = Router();
    const handle = (req, res) => {
      let query: any = {};
      if (req.method === "GET") {
        query = req.query;
      } else if (req.method === "POST") {
        query = req.body;
      }

      const message: any = {
        keyword: query.keyword,
        messageId: query.messageId,
        msisdn: query.msisdn,
        text: query.text,
        timestamp: query["message-timestamp"],
        to: query.to,
      };

      this.emitter.emit("message", message);
      // Assume all went well.
      res.sendStatus(200);
    };

    router.get("/", handle);
    router.post("/", handle);

    return router;
  }
}
