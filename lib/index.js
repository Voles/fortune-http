'use strict'

var zlib = require('zlib')
var crc32 = require('fast-crc32c')
var Negotiator = require('negotiator')

var HttpSerializer = require('./serializer')
var jsonSerializer = require('./json_serializer')
var htmlSerializer = require('./html_serializer')
var HttpFormSerializer = require('./form_serializer')
var statusMapFn = require('./status_map')
var instantiateSerializer = require('./instantiate_serializer')

var beforeSemicolon = /[^;]*/
var availableEncodings = [ 'gzip', 'deflate' ]
var buffer = Buffer.from || Buffer


/**
 * **Node.js only**: This function implements a HTTP server for Fortune.
 *
 * ```js
 * const http = require('http')
 * const fortuneHTTP = require('fortune-http')
 *
 * const listener = fortuneHTTP(fortuneInstance, options)
 * const server = http.createServer((request, response) =>
 *   listener(request, response)
 *   .catch(error => {
 *     // error logging
 *   }))
 * ```
 *
 * It determines which serializer to use, assigns request headers
 * to the `meta` object, reads the request body, and maps the response from
 * the `request` method on to the HTTP response. The listener function ends the
 * response and returns a promise that is resolved when the response is ended.
 * The returned promise may be rejected with the error response, providing a
 * hook for error logging.
 *
 * The options object may be formatted as follows:
 *
 * ```js
 * {
 *   // An array of HTTP serializers, ordered by priority. Defaults to ad hoc
 *   // JSON and form serializers if none are specified. If a serializer value
 *   // is not an array, its settings will be considered omitted.
 *   serializers: [
 *     [
 *       // A function that subclasses the HTTP Serializer.
 *       HttpSerializerSubclass,
 *
 *       // Settings to pass to the constructor, optional.
 *       { ... }
 *     ]
 *   ],
 *   settings: {
 *     // By default, the listener will end the response, set this to `false`
 *     // if the response will be ended later.
 *     endResponse: true,
 *
 *     // Use compression if the request `Accept-Encoding` header allows it.
 *     // Note that Buffer-typed responses will not be compressed. This option
 *     // should be disabled in case of a reverse proxy which handles
 *     // compression.
 *     useCompression: true,
 *
 *     // Use built-in ETag implementation, which uses CRC32 for generating
 *     // weak ETags under the hood. This option should be disabled in case of
 *     // a reverse proxy which handles ETags.
 *     useETag: true
 *   }
 * }
 * ```
 *
 * The main export contains the following keys:
 *
 * - `Serializer`: HTTP Serializer class.
 * - `JsonSerializer`: JSON over HTTP serializer.
 * - `HtmlSerializer`: HTML serializer.
 * - `FormDataSerializer`: Serializer for `multipart/formdata`.
 * - `FormUrlEncodedSerializer`: Serializer for
 *   `application/x-www-form-urlencoded`.
 * - `instantiateSerializer`: an internal function with the signature
 *   (`instance`, `serializer`, `options`), useful if one needs to get an
 *   instance of the serializer without the HTTP listener.
 *
 * @param {Fortune} instance
 * @param {Object} [options]
 * @return {Function}
 */
function createListener (instance, options) {
  var mediaTypes = []
  var serializers = {}
  var serializer, input, settings, endResponse, useCompression, useETag
  var errors, nativeErrors
  var BadRequestError, UnsupportedError, NotAcceptableError
  var assign, message, responses, statusMap
  var i, j

  if (!instance.request || !instance.common)
    throw new TypeError('An instance of Fortune is required.')

  assign = instance.common.assign
  message = instance.common.message
  responses = instance.common.responses
  statusMap = statusMapFn(responses)

  errors = instance.common.errors
  nativeErrors = errors.nativeErrors
  BadRequestError = errors.BadRequestError
  UnsupportedError = errors.UnsupportedError
  NotAcceptableError = errors.NotAcceptableError

  if (options === void 0) options = {}
  if (!('serializers' in options))
    options.serializers = [
      jsonSerializer(HttpSerializer),
      htmlSerializer(HttpSerializer),
      HttpFormSerializer.formData,
      HttpFormSerializer.formUrlEncoded
    ]
  if (!('settings' in options)) options.settings = {}
  settings = options.settings

  if (!options.serializers.length)
    throw new Error('At least one serializer must be defined.')

  for (i = 0, j = options.serializers.length; i < j; i++) {
    input = Array.isArray(options.serializers[i]) ?
      options.serializers[i] : [ options.serializers[i] ]

    serializer = instantiateSerializer(instance, input[0], input[1])
    serializers[serializer.mediaType] = serializer
    mediaTypes.push(serializer.mediaType)
  }

  endResponse = 'endResponse' in settings ? settings.endResponse : true
  useETag = 'useETag' in settings ? settings.useETag : true
  useCompression = 'useCompression' in settings ?
    settings.useCompression : true

  // Expose HTTP status code map.
  listener.statusMap = statusMap

  return listener

  // We can take advantage of the closure which has a reference to the
  // Fortune instance.
  function listener (request, response) {
    var encoding, payload, isProcessing, contextResponse
    var negotiator = new Negotiator(request)
    var language = negotiator.language()

    // Using Negotiator to get the highest priority media type.
    var serializerOutput = negotiator.mediaType(mediaTypes)

    // Get the media type of the request.
    // See RFC 2045: https://www.ietf.org/rfc/rfc2045.txt
    var serializerInput = beforeSemicolon
      .exec(request.headers['content-type'] || '')[0] || null

    var contextRequest = {
      meta: { headers: request.headers, language: language }
    }

    // Invalid media type requested. The `undefined` return value comes from
    // the Negotiator library.
    if (serializerOutput === void 0)
      serializerOutput = negotiator.mediaType()
    else response.setHeader('Content-Type', serializerOutput)

    if (useCompression) {
      encoding = negotiator.encoding(availableEncodings)
      if (encoding) response.setHeader('Content-Encoding', encoding)
    }

    // Set status code to null value, which we can check later if status code
    // should be overwritten or not.
    response.statusCode = null

    return new Promise(function (resolve, reject) {
      var chunks = []

      request.on('error', function (error) {
        response.setHeader('Content-Type', 'text/plain')
        error.payload = message('InvalidBody', language)
        error.isInputError = true
        reject(error)
      })

      if (request.body) {
        resolve(Buffer.from(JSON.stringify(request.body), 'utf8'));
      } else {
        request.on('data', function (chunk) { chunks.push(chunk) })
        request.on('end', function () { resolve(Buffer.concat(chunks)) })
      }
    })

    .then(function (body) {
      if (body.length) payload = body

      if (!serializers.hasOwnProperty(serializerOutput))
        throw new NotAcceptableError(message(
          'SerializerNotFound', language, { id: serializerOutput }))

      return serializers[serializerOutput]
        .processRequest(contextRequest, request, response)
    })

    .then(function (contextRequest) {
      if (!serializerInput) return contextRequest

      if (!serializers.hasOwnProperty(serializerInput))
        throw new UnsupportedError(message(
          'SerializerNotFound', language, { id: serializerInput }))

      contextRequest.payload = payload

      return Promise.resolve()
      .then(function () {
        return payload && payload.length ?
          serializers[serializerInput]
            .parsePayload(contextRequest, request, response) : null
      })
      .then(function (payload) {
        contextRequest.payload = payload
        return contextRequest
      }, function (error) {
        error.isInputError = true
        throw error
      })
    })

    .then(function (contextRequest) {
      return instance.request(contextRequest)
    })

    .then(function (result) {
      contextResponse = result
      isProcessing = true

      return serializers[serializerOutput]
        .processResponse(contextResponse, request, response)
    })

    .then(function (contextResponse) {
      return end(contextResponse, request, response)
    })

    .catch(function (error) {
      return Promise.resolve()
      .then(function () {
        var exposedError = error

        if (!('payload' in error || 'meta' in error) &&
          ~nativeErrors.indexOf(error.constructor)) {
          if (contextResponse) delete contextResponse.payload
          exposedError = assign(error.isInputError ?
            new BadRequestError(message('InvalidBody', language)) :
            new Error(message('GenericError', language)),
            contextResponse)
        }

        return !isProcessing && serializers.hasOwnProperty(serializerOutput) ?
          serializers[serializerOutput]
            .processResponse(exposedError, request, response) :
          exposedError
      })
      .then(function (error) {
        return end(error, request, response)
      }, function () {
        return end(new Error(message('GenericError', language)),
          request, response)
      })
      .then(function () {
        // Do not reject exceptions that result in non-error status codes.
        if (response.statusCode < 400) return error

        throw error
      })
    })
  }

  // Internal function to end the response.
  function end (contextResponse, request, response) {
    var encoding, payload, meta
    var connection = request.headers['connection']

    if (!('meta' in contextResponse)) contextResponse.meta = {}
    if (!('headers' in contextResponse.meta)) contextResponse.meta.headers = {}
    meta = contextResponse.meta
    payload = contextResponse.payload

    if (response.statusCode === null)
      response.statusCode = statusMap.get(contextResponse.constructor) ||
        statusMap.get(Error)

    // The special `Connection` header notifies Node.js that the server should
    // be persisted, unless explicitly specified otherwise.
    // See: https://serverfault.com/questions/322683
    if (!(connection && connection.toLowerCase() === 'close'))
      response.setHeader('Connection', 'keep-alive')

    return new Promise(function (resolve, reject) {
      if (contextResponse instanceof Error &&
        !('payload' in contextResponse || 'meta' in contextResponse))
        return reject(contextResponse)

      if (Buffer.isBuffer(payload) || typeof payload === 'string') {
        encoding = response.getHeader('Content-Encoding')

        if (encoding && ~availableEncodings.indexOf(encoding))
          return zlib[encoding](payload, function (error, result) {
            if (error) throw error
            payload = contextResponse.payload = result
            meta.headers['Content-Length'] = payload.length
            return resolve()
          })

        response.removeHeader('Content-Encoding')
        payload = contextResponse.payload = buffer(payload)
        meta.headers['Content-Length'] = payload.length
        return resolve()
      }

      if (payload) {
        response.statusCode = statusMap.get(Error)
        return reject(new Error('Response payload type is invalid.'))
      }

      // Handle empty response.
      response.removeHeader('Content-Encoding')
      response.removeHeader('Content-Type')
      if (response.statusCode === statusMap.get(responses.OK))
        response.statusCode = (statusMap.get(responses.Empty))
      payload = contextResponse.payload = ''
      return resolve()
    })
    .then(function () {
      return new Promise(function (resolve) {
        var field, etag

        for (field in meta.headers)
          response.setHeader(field, meta.headers[field])

        if (useETag && payload) {
          etag = 'W/' + crc32.calculate(payload).toString(16)
          response.setHeader('ETag', etag)

          if (!endResponse) return resolve(contextResponse)

          if (request.headers['if-none-match'] === etag) {
            response.statusCode = 304
            response.removeHeader('Content-Encoding')
            response.removeHeader('Content-Type')
            response.removeHeader('Content-Length')
            return response.end(function () { resolve(contextResponse) })
          }
        }

        else if (!endResponse) return resolve(contextResponse)

        return response.end(payload, function () { resolve(contextResponse) })
      })
    })
    .catch(function (error) {
      return new Promise(function (resolve) {
        var message = error.toString()
        if (response.statusCode == null)
          response.statusCode = statusMap.get(Error)
        response.removeHeader('Content-Encoding')
        response.setHeader('Content-Type', 'text/plain')
        response.setHeader('Content-Length', Buffer.byteLength(message))
        response.end(message, function () { resolve(error) })
      })
    })
  }
}


// Expose instantiation method.
createListener.instantiateSerializer = instantiateSerializer

// Expose HTTP Serializer class, and defaults.
createListener.Serializer = HttpSerializer
createListener.JsonSerializer = jsonSerializer(HttpSerializer)
createListener.HtmlSerializer = htmlSerializer(HttpSerializer)
createListener.FormDataSerializer = HttpFormSerializer.formData
createListener.FormUrlEncodedSerializer = HttpFormSerializer.formUrlEncoded


module.exports = createListener
