import { MoopsyStream } from "@moopsyjs/core";
import { ReadableMoopsyStream } from "./models/readable-moopsy-stream";

export type ReplaceMoopsyStreamWithReadable<T> = {
    [K in keyof T]: T[K] extends MoopsyStream<infer U> ? ReadableMoopsyStream<U> : T[K];
};