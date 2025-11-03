/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { ExtensionUtils } from "resource://gre/modules/ExtensionUtils.sys.mjs";

const { DefaultMap } = ExtensionUtils;

const lazy = {};

XPCOMUtils.defineLazyServiceGetter(
    lazy,
    "mimeHeader",
    "@mozilla.org/network/mime-hdrparam;1",
    "nsIMIMEHeaderParam"
);

const BinaryInputStream = Components.Constructor(
    "@mozilla.org/binaryinputstream;1",
    "nsIBinaryInputStream",
    "setInputStream"
);
const ConverterInputStream = Components.Constructor(
    "@mozilla.org/intl/converter-input-stream;1",
    "nsIConverterInputStream",
    "init"
);

export var WebRequestReplaceCredentials;

// ------------------- Helpers --------------------

class Headers extends Map {
    constructor(headerText) {
        super();
        if (headerText) {
            this.parseHeaders(headerText);
        }
    }
    parseHeaders(headerText) {
        let lines = headerText.split("\r\n");
        let lastHeader;
        for (let line of lines) {
            if (line === "") return;
            if (/^\s/.test(line)) {
                if (lastHeader) {
                    let val = this.get(lastHeader);
                    this.set(lastHeader, `${val}\r\n${line}`);
                }
                continue;
            }
            let match = /^(.*?)\s*:\s+(.*)/.exec(line);
            if (match) {
                lastHeader = match[1].toLowerCase();
                this.set(lastHeader, match[2]);
            }
        }
    }
    getParam(name, paramName) {
        return Headers.getParam(this.get(name), paramName);
    }
    static getParam(header, paramName) {
        if (header) {
            let bytes = new TextEncoder().encode(header);
            let binHeader = String.fromCharCode(...bytes);
            return lazy.mimeHeader.getParameterHTTP(binHeader, paramName, null, false, {});
        }
        return null;
    }
}

function mapToObject(map) {
    let result = {};
    for (let [key, value] of map) {
        result[key] = value;
    }
    return result;
}

function rewind(stream) {
    stream.QueryInterface(Ci.nsISeekableStream);
    try {
        stream.seek(0, 0);
    } catch (e) {
        Cu.reportError(e);
    }
}

function* getStreams(outerStream) {
    let unbuffered = outerStream;
    if (outerStream instanceof Ci.nsIStreamBufferAccess) {
        unbuffered = outerStream.unbufferedStream;
    }
    if (unbuffered instanceof Ci.nsIMultiplexInputStream) {
        for (let i = 0; i < unbuffered.count; i++) {
            yield unbuffered.getStream(i);
        }
    } else {
        yield outerStream;
    }
}

function mergeBuffers(buffers) {
    let totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
    let merged = new Uint8Array(totalLength);
    let offset = 0;
    for (let b of buffers) {
        merged.set(b, offset);
        offset += b.length;
    }
    return merged.buffer;
}

// ------------------- Form Parsing --------------------

function parseFormData(stream, channel, credentials, url, lenient = false) {
    const BUFFER_SIZE = 8192;
    let touchedStreams = new Set();
    let converterStreams = [];
    let formParseResponse = { hasChangedBody: false, rawFormData: "" };

    function createTextStream(stream) {
        if (!(stream instanceof Ci.nsISeekableStream)) {
            return null;
        }
        touchedStreams.add(stream);
        let converterStream = ConverterInputStream(
            stream,
            "UTF-8",
            0,
            lenient ? Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER : 0
        );
        converterStreams.push(converterStream);
        return converterStream;
    }

    function readString(stream, length = BUFFER_SIZE) {
        let data = {};
        stream.readString(length, data);
        return data.value;
    }

    function* getTextStreams(outerStream) {
        for (let stream of getStreams(outerStream)) {
            if (stream instanceof Ci.nsIStringInputStream) {
                touchedStreams.add(outerStream);
                yield createTextStream(stream);
            }
        }
    }

    function* readAllStrings(outerStream) {
        for (let textStream of getTextStreams(outerStream)) {
            let str;
            while ((str = readString(textStream))) {
                yield str;
            }
        }
    }

    function* getParts(stream, boundary, tail = "") {
        for (let chunk of readAllStrings(stream)) {
            chunk = tail + chunk;
            let parts = chunk.split(boundary);
            tail = parts.pop();
            yield* parts;
        }
        if (tail) {
            yield tail;
        }
    }

    function parseMultiPart(stream, boundary) {
        let formData = new DefaultMap(() => []);
        let rawFormData = [];
        for (let part of getParts(stream, boundary, "\r\n")) {
            if (part === "") {
                rawFormData.push(part);
                continue;
            }
            if (part === "--\r\n") {
                rawFormData.push(part);
                break;
            }

            let rawPartString = [];
            let end = part.indexOf("\r\n\r\n");
            if (!part.startsWith("\r\n") || end <= 0) {
                throw new Error("Invalid MIME stream");
            }

            let content = part.slice(end + 4);
            let headerText = part.slice(2, end);
            let headers = new Headers(headerText);

            let name = headers.getParam("content-disposition", "name");
            if (!name || headers.getParam("content-disposition", "") !== "form-data") {
                throw new Error("Invalid MIME stream: No valid Content-Disposition header");
            }

            name = name.replace(/(%[0-9A-Fa-f]{2})+/g, match => {
                const bytes = new Uint8Array(match.length / 3);
                for (let i = 0; i < match.length / 3; i++) {
                    bytes[i] = parseInt(match.substring(i * 3 + 1, (i + 1) * 3), 16);
                }
                return new TextDecoder("utf-8").decode(bytes);
            });

            if (credentials.hasOwnProperty(name)) {
                formParseResponse.hasChangedBody = true;
                rawPartString.push("\r\n");
                rawPartString.push(headerText);
                rawPartString.push("\r\n\r\n");
                rawPartString.push(credentials.get(name));
                rawFormData.push(rawPartString.join("")); // fixed join
            } else {
                rawFormData.push(part);
            }

            if (headers.has("content-type")) {
                let filename = headers.getParam("content-disposition", "filename");
                content = filename || "";
            }
            formData.get(name).push(content);
        }
        return rawFormData.join(boundary);
    }

    function parseUrlEncoded(stream, credentials) {
        let rawFormData = [];
        for (let part of getParts(stream, "&")) {
            let [name, value] = part.replace(/\+/g, " ").split("=").map(decodeURIComponent);
            if (credentials.hasOwnProperty(name)) {
                const fieldCredentials = credentials[name];
                if (value === fieldCredentials.nonce) {
                    formParseResponse.hasChangedBody = true;
                    rawFormData.push(encodeURIComponent(name) + "=" + encodeURIComponent(fieldCredentials.actual));
                } else {
                    rawFormData.push(part);
                }
            } else {
                rawFormData.push(part);
            }
        }
        return rawFormData.join("&");
    }

    try {
        if (stream instanceof Ci.nsIMIMEInputStream && stream.data) {
            stream = stream.data;
        }
        channel.QueryInterface(Ci.nsIHttpChannel);
        let contentType = channel.getRequestHeader("Content-Type");

        switch (Headers.getParam(contentType, "")) {
            case "multipart/form-data":
                let boundary = Headers.getParam(contentType, "boundary");
                formParseResponse.rawFormData = parseMultiPart(stream, `\r\n--${boundary}`);
                return formParseResponse;

            case "application/x-www-form-urlencoded":
                formParseResponse.rawFormData = parseUrlEncoded(stream, credentials);
                return formParseResponse;
        }
    } finally {
        for (let stream of touchedStreams) rewind(stream);
        for (let converterStream of converterStreams) {
            converterStream.init(null, null, 0, 0);
        }
    }
    return null;
}

function createFormData(stream, channel, credentials, url, lenient) {
    if (!(stream instanceof Ci.nsISeekableStream)) return null;
    try {
        return parseFormData(stream, channel, credentials, url, lenient);
    } catch (e) {
        Cu.reportError(e);
    } finally {
        rewind(stream);
    }
}

function* getRawDataChunked(outerStream, maxRead = WebRequestReplaceCredentials.MAX_RAW_BYTES) {
    for (let stream of getStreams(outerStream)) {
        let unbuffered = stream;
        if (stream instanceof Ci.nsIStreamBufferAccess) {
            unbuffered = stream.unbufferedStream;
        }
        if (unbuffered instanceof Ci.nsIFileInputStream || unbuffered instanceof Ci.mozIRemoteLazyInputStream) {
            yield { file: "<file>" };
            continue;
        }
        try {
            let binaryStream = BinaryInputStream(stream);
            let available;
            while ((available = binaryStream.available())) {
                let buffer = new ArrayBuffer(Math.min(maxRead, available));
                binaryStream.readArrayBuffer(buffer.byteLength, buffer);
                maxRead -= buffer.byteLength;
                let chunk = { bytes: buffer };
                if (buffer.byteLength < available) {
                    chunk.truncated = true;
                    chunk.originalSize = available;
                }
                yield chunk;
                if (maxRead <= 0) return;
            }
        } finally {
            rewind(stream);
        }
    }
}


WebRequestReplaceCredentials = {
    /**
     * Enhanced credential replacement that handles complex nested structures
     * Supports both simple key-value pairs and field arrays like in GraphQL
     * @param {Object} obj - The JSON object to process
     * @param {Object} credentials - Credential mapping { fieldKey: { nonce, actual } }
     * @returns {boolean} - Whether any changes were made
     */
    replaceCredentialsInJsonObject(obj, credentials) {
        let hasChanged = false;

        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                let item = obj[i];

                if (typeof item === 'object' && item !== null) {
                    if (item.name && item.value && typeof item.name === 'string') {
                        let fieldName = item.name;
                        let fieldValue = item.value;

                        if (credentials.hasOwnProperty(fieldName)) {
                            let field = credentials[fieldName];
                            let actualValue = this.extractStringValue(fieldValue);

                            if (actualValue === field.nonce) {
                                this.replaceStringValue(fieldValue, field.actual);
                                hasChanged = true;
                                // console.log(`Replaced credential in field array "${fieldName}": "${field.nonce}" -> "${field.actual}"`);
                            }
                        }
                    }

                    if (this.replaceCredentialsInJsonObject(item, credentials)) {
                        hasChanged = true;
                    }
                }
            }
        }
        else if (typeof obj === 'object' && obj !== null) {
            for (let key in obj) {
                if (obj.hasOwnProperty(key)) {
                    let value = obj[key];

                    if (typeof value === 'object' && value !== null) {
                        if (this.replaceCredentialsInJsonObject(value, credentials)) {
                            hasChanged = true;
                        }
                    }
                    else if (typeof value === 'string') {
                        if (credentials.hasOwnProperty(key)) {
                            let field = credentials[key];
                            if (value === field.nonce) {
                                obj[key] = field.actual;
                                hasChanged = true;
                                // console.log(`Replaced credential for key "${key}": "${field.nonce}" -> "${field.actual}"`);
                            }
                        }
                    }
                }
            }
        }

        return hasChanged;
    },

    /**
     * Extracts string value from various value structures
     * Handles: "string", {"stringValue": "string"}, {"value": "string"}, etc.
     */
    extractStringValue(valueObj) {
        if (typeof valueObj === 'string') {
            return valueObj;
        }
        if (typeof valueObj === 'object' && valueObj !== null) {
            // Try common patterns
            if (valueObj.stringValue) return valueObj.stringValue;
            if (valueObj.value) return valueObj.value;
            if (valueObj.text) return valueObj.text;
            if (valueObj.data) return valueObj.data;
        }
        return null;
    },

    /**
     * Replaces string value in various value structures while preserving the structure
     */
    replaceStringValue(valueObj, newValue) {
        if (typeof valueObj === 'string') {
            return newValue;
        }
        if (typeof valueObj === 'object' && valueObj !== null) {
            // Replace in common patterns
            if (valueObj.hasOwnProperty('stringValue')) {
                valueObj.stringValue = newValue;
                return true;
            }
            if (valueObj.hasOwnProperty('value')) {
                valueObj.value = newValue;
                return true;
            }
            if (valueObj.hasOwnProperty('text')) {
                valueObj.text = newValue;
                return true;
            }
            if (valueObj.hasOwnProperty('data')) {
                valueObj.data = newValue;
                return true;
            }
        }
        return false;
    },

    /**
     * Processes JSON content and replaces credentials
     * @param {ReadableStream} stream - The request stream
     * @param {Object} credentials - Credential mapping
     * @returns {Object} - { hasChanged: boolean, newBodyString: string }
     */
    processJsonContent(stream, credentials) {
        console.log("Processing JSON content");
        let rawBytes = [];

        // Read all chunks from stream
        for (let chunk of getRawDataChunked(stream)) {
            if (chunk.bytes) rawBytes.push(new Uint8Array(chunk.bytes));
        }

        let jsonBuffer = mergeBuffers(rawBytes);
        let jsonText = new TextDecoder("utf-8").decode(jsonBuffer);

        try {
            let jsonObj = JSON.parse(jsonText);
            console.log("Original JSON object:", jsonObj);
            console.log("Credentials to replace:", credentials);

            // Use deep inspection to replace credentials
            let hasChanged = this.replaceCredentialsInJsonObject(jsonObj, credentials);

            if (hasChanged) {
                let newBodyString = JSON.stringify(jsonObj);
                console.log("Modified JSON body:", newBodyString);
                return { hasChanged: true, newBodyString };
            } else {
                console.log("No credentials found in JSON to replace");
                return { hasChanged: false, newBodyString: jsonText };
            }
        } catch (e) {
            Cu.reportError("JSON parsing failed: " + e);
            console.log("JSON parsing error:", e);
            return { hasChanged: false, newBodyString: jsonText };
        }
    },

    /**
     * Main function to replace credentials in request body
     * @param {nsIHttpChannel} channel - The HTTP channel
     * @param {nsIHttpChannel} channelId - Id of the HTTP channel
     * @param {Object} credentials - Credential mapping { fieldKey: { nonce, actual } }
     * @param {string} url - Request URL
     * @returns {Object} - Result object with success/error status
     */
    replaceRawCredentials(channel, channelId, credentials, url) {
        if (!(channel instanceof Ci.nsIUploadChannel) || !channel.uploadStream) {
            return { error: "Unsupported stream type" };
        }

        if (channel instanceof Ci.nsIUploadChannel2 && channel.uploadStreamHasHeaders) {
            return { error: "Upload streams with headers are unsupported" };
        }

        try {
            console.log(`ANALYTICS: Start request body replacement with credentials [channel=${channelId}] URL=${url}`);

            let formStartTime = Cu.now();

            let stream = channel.uploadStream;
            channel.QueryInterface(Ci.nsIHttpChannel);
            let contentType = channel.getRequestHeader("Content-Type") || "";

            // console.log("Content-Type:", contentType);
            // console.log("Replacing credentials:", credentials);

            let hasChangedBody = false;
            let newBodyString = "";

            // Handle JSON content
            if (contentType.includes("application/json") || contentType.endsWith("+json")) {
                let result = this.processJsonContent(stream, credentials);
                hasChangedBody = result.hasChanged;
                newBodyString = result.newBodyString;
            }
            // Handle form data
            else {
                // console.log("Processing form data");
                let formParseResponse = createFormData(stream, channel, credentials, url);
                if (formParseResponse) {
                    hasChangedBody = formParseResponse.hasChangedBody;
                    newBodyString = formParseResponse.rawFormData;
                }
            }

            console.log(`ANALYTICS: Completed procesing body in ${(Cu.now() - formStartTime).toFixed(3)} ms [channel=${channelId}] URL=${url}`);

            let replacementStartTime = Cu.now();
            // Replace the request body if changes were made
            if (hasChangedBody && newBodyString) {
                let streamWithCredentials = Cc["@mozilla.org/io/string-input-stream;1"]
                    .createInstance(Ci.nsIStringInputStream);
                streamWithCredentials.setByteStringData(newBodyString);

                channel.QueryInterface(Ci.nsIUploadChannel2);
                channel.explicitSetUploadStream(
                    streamWithCredentials,
                    contentType,
                    newBodyString.length,
                    channel.requestMethod,
                    false
                );

                // Update Content-Length header
                try {
                    let originalContentLength = channel.getRequestHeader("Content-Length");
                    // console.log("Original Content-Length header:", originalContentLength);
                } catch (e) {
                    console.log("No original Content-Length header found");
                }

                const correctByteLength = new TextEncoder().encode(newBodyString).length;
                channel.setRequestHeader("Content-Length", correctByteLength.toString(), false);

                const endTime = Cu.now();
                console.log(`ANALYTICS: Completed body replacement ${(endTime - replacementStartTime).toFixed(3)} ms [channel=${channelId}] URL=${url}`);
                console.log(`ANALYTICS: Completed overall processing in ${(endTime - formStartTime).toFixed(3)} ms [channel=${channelId}] URL=${url}`);
                console.log(`ANALYTICS: Successfully replaced request body with credentials [channel=${channelId}] URL=${url}`);
            }

            return {
                success: true,
                message: hasChangedBody ? "Credentials inserted" : "No changes needed",
                modified: hasChangedBody
            };

        } catch (e) {
            Cu.reportError(e);
            console.log("Error in replaceRawCredentials:", e);
            return { success: false, error: e.message || String(e) };
        }
    },
};

XPCOMUtils.defineLazyPreferenceGetter(
    WebRequestReplaceCredentials,
    "MAX_RAW_BYTES",
    "webextensions.webRequest.requestBodyMaxRawBytes"
);
