// Library for handling logging in a sane manner, including automatic
// log rotation based on strftime and strack tracing where appropriate
//
// This can be included in your service in one of two ways:

var Winston      = require('winston'),    // logger of choice by node nerds everywhere
    Path         = require('path'),      
    Mkdirp       = require('mkdirp'),     // for handling log dir creation transparently
    Util         = require('util'),
    FS           = require('fs'),
    ChildProcess = require('child_process'),
    Strftime     = require('strftime');   // formats timestrings ala strftime :-)

// We need to slightly modify the default File transport provided by Winston
// in order to handle log rotation.  We'll inherit most of what we need and just 
// override the filename and open functions
var RotateFile = function(options) {
	Winston.transports.File.call(this, options);
	this.symlink = options.symlink;
}
Util.inherits(RotateFile, Winston.transports.File);

// Change open so that it rotates only when the strftime format in the filename
// changes
RotateFile.prototype.open = function(callback) {
	var filename = this._getFile();
	if (this.opening) {
		return callback(true);
	}
	else if (!this._stream || (this._currentfilename != filename)) {
		callback(true);
		Mkdirp.sync(Path.dirname(filename));
		if (this.symlink) {
			var symlink = process.env.EC_LOGTOP + '/' + this.symlink;
			ChildProcess.exec('ln -fs ' + filename + ' ' + symlink, function(){});
		}
		this._currentfilename = filename;
		return this._createStream();
	}
	callback();
}

// Use strftime to fill out timestamp information in our log files
RotateFile.prototype._getFile = function() {
	var filename = this._basename;
	if (!filename.match(/^\//)) {
		filename = process.env.EC_LOGTOP + '/' + filename;
	}
	this.dirname = '/';
	return Strftime(filename);
}

// Main function; here we initiate a baseline console logger based on the types
// of logging we'll need.  If this is iniaited with a filename, we'll add a 
// RotateFile transport below.  We also have the option of enabling a transport
// for criticals that will email us
function logger(options) {
	options = !options ? {} : options;
	var winston_logger = new (Winston.Logger)({
		transports: [
			// FIXME: set up critical email alerts for prod
			// new (Winston.transports.SNS)({
			//     aws_key: key,
			//     aws_secret: secret,
			//     subscriber_number: number,
			//     topic_arn: arn,
			//     region: 'us-east-1',
			//     subject: '[CRITICAL] Failure in prod',
			//     message: "%e %m",
			//     level: critical
			// })
		],
		levels: {
			debug:    1,
			info:     2,
			warn:     3,
			error:    4,
			critical: 5,
			trace:    6
		},
		colors: {
			debug:    'green',
			info:     'white',
			warn:     'yellow',
			error:    'red',
			critical: 'magenta',
			trace:    'blue'
		},
		exitOnError:  false
	});
	if (options.console !== false) {
		winston_logger.add(Winston.transports.Console,
			{
				timestamp:        _timestamp,
				colorize:         true,
				prettyPrint:      true,
				level:            'debug'
			});
	}
	if (options.filename) {
		winston_logger.add(RotateFile,
			{
				timestamp:   _timestamp,
				filename:    options.filename,
				colorize:    false,
				json:        false,
				prettyPrint: true,
				level:       'debug',
				symlink:     options.symlink
			});
	}

	// some vodoo here; we want to automagically log a stack trace when error, debug
	// or critical errors occur.  We essential overwrite the parent class for each
	// method and at a stack trace
	winston_logger.extend(this);
	this.levels = winston_logger.levels;
	this.log = function(message, meta, callback) {
		var log_meta = options.console !== false ? undefined : meta;
		if (callback) {
			winston_logger.info(message, callback);
		}
		else {
			winston_logger.info(message);
		}
	}
	this.error = function(message, meta, callback) {
		var stack = _format_stack(message);
		var log_meta = options.console !== false ? undefined : meta;
		if (typeof(meta) == "function") {
			callback = meta;
		}
		winston_logger.error(stack[1], log_meta, function() { 
			winston_logger.trace(stack[0], callback) 
		});
	}
	this.debug = function(message, meta, callback) {
		var log_meta = options.console !== false ? undefined : meta;
		if (typeof(meta) == "function") {
			callback = meta;
		}
		var stack = _format_stack(message);
		winston_logger.debug(stack[1], log_meta, function() { winston_logger.trace(stack[0], meta, callback) });
	}
	this.critical = function(message, meta, callback) {
		var log_meta = options.console !== false ? undefined : meta;
		if (typeof(meta) == "function") {
			callback = meta;
		}
		var stack = _format_stack(message);
		winston_logger.critical(stack[1], log_meta, function() { winston_logger.trace(stack[0], meta, callback) });
	}
}

// for Stack tracing.  See commented out section below for customizing the output
// of stack traces.  I'm not a big fan of altering prepareStackTrace since it is
// a blocking operation.
function _format_stack(message) {
	var id = _uuid();
	message = message + ' | trace: ' + id;
	var error = new Error(id);
	var stack = error.stack;
	stack = stack.replace(/Error:\s/,'');
	// this is somewhat hackish, but messing with prepareStackTrace can lead to blocking 
	// problems.  Better to just strip out superfluous lines with regex
	stack = stack.replace(/    at logger.*?\n/,'');
	stack = stack.replace(/    at logger.*?\n/,'');
	stack = stack.replace(/    at _format_stack.*?\n/,'');
	return [stack,message];
}

logger.prototype.extend = function(target) {
  var self = this;
  ['log', 'profile', 'startTimer'].concat(Object.keys(this.levels)).forEach(function (method) {
    target[method] = function () {
      return self[method].apply(self, arguments);
    };
  });
  return this;
}

// If someday you need more insight or don't like the stack trace format, you can
// overide the V8 engines trace here.  For complete details see
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
//
// var old = Error.prepareStackTrace;
//
// Error.prepareStackTrace = function(error, structuredStackTrace) {
// 	var formatted_trace = [];
// 	structuredStackTrace.splice(0,0);
// 	for (i in structuredStackTrace) {
// 		var callSite = structuredStackTrace[i];
// 		formatted_trace.push(
//			'\t' +
//			callSite.getTypeName()     + ' ' +
//			callSite.getFunction()     + ' ' +
//			callSite.getMethodName()   + ' ' +
//			callSite.getEvalOrigin()   + ' ' +
//			callSite.isToplevel()      + ' ' +
//			callSite.isEval()          + ' ' +
//			callSite.isNative()        + ' ' +
//			callSite.isConstructor()   + ' ' +
//		    callSite.getFileName()     + ' ' + 
//			callSite.getFunctionName() + ' ' + 
//			callSite.getLineNumber()   + ' ' + 
//			callSite.getColumnNumber()
//		);
//	}
//	return "\n" + formatted_trace.join("\n");
//}
//
// //Error.prepareStackTrace = old;

// util function for returning the timestamp to include in logs. 
function _timestamp() {
	return Strftime('%Y-%m-%d %H:%M:%S');
}

function _uuid(a) {
	return a?(0|Math.random()*16).toString(16):(""+1e7+-1e3+-4e3+-8e3+-1e11).replace(/1|0/g,_uuid)
}

module.exports = logger;
