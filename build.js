(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
	typeof define === 'function' && define.amd ? define(['exports'], factory) :
	(global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.index = {}));
})(this, (function (exports) { 'use strict';

	/*
	 * Copyright 2010-2020 Gildas Lormeau
	 * contact : gildas.lormeau <at> gmail.com
	 * 
	 * This file is part of SingleFile.
	 *
	 *   The code in this file is free software: you can redistribute it and/or 
	 *   modify it under the terms of the GNU Affero General Public License 
	 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
	 *   of the License, or (at your option) any later version.
	 * 
	 *   The code in this file is distributed in the hope that it will be useful, 
	 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
	 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
	 *   General Public License for more details.
	 *
	 *   As additional permission under GNU AGPL version 3 section 7, you may 
	 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
	 *   AGPL normally required by section 4, provided you include this license 
	 *   notice and a URL through which recipients can access the Corresponding 
	 *   Source.
	 */

	/* global browser, fetch, TextDecoder */

	let contentScript, frameScript;

	const contentScriptFiles = [
		"lib/chrome-browser-polyfill.js",
		"lib/single-file.js"
	];

	const frameScriptFiles = [
		"lib/chrome-browser-polyfill.js",
		"lib/single-file-frames.js"
	];

	const basePath = "../../../";

	async function inject(tabId, options) {
		await initScripts(options);
		let scriptsInjected;
		if (!options.removeFrames) {
			try {
				await browser.tabs.executeScript(tabId, { code: frameScript, allFrames: true, matchAboutBlank: true, runAt: "document_start" });
			} catch (error) {
				// ignored
			}
		}
		try {
			await browser.tabs.executeScript(tabId, { code: contentScript, allFrames: false, runAt: "document_idle" });
			scriptsInjected = true;
		} catch (error) {
			// ignored
		}
		if (scriptsInjected) {
			if (options.frameId) {
				await browser.tabs.executeScript(tabId, { code: "document.documentElement.dataset.requestedFrameId = true", frameId: options.frameId, matchAboutBlank: true, runAt: "document_start" });
			}
		}
		return scriptsInjected;
	}

	async function initScripts(options) {
		const extensionScriptFiles = options.extensionScriptFiles || [];
		if (!contentScript && !frameScript) {
			[contentScript, frameScript] = await Promise.all([
				getScript(contentScriptFiles.concat(extensionScriptFiles)),
				getScript(frameScriptFiles)
			]);
		}
	}

	async function getScript(scriptFiles) {
		const scriptsPromises = scriptFiles.map(async scriptFile => {
			if (typeof scriptFile == "function") {
				return "(" + scriptFile.toString() + ")();";
			} else {
				const scriptResource = await fetch(browser.runtime.getURL(basePath + scriptFile));
				return new TextDecoder().decode(await scriptResource.arrayBuffer());
			}
		});
		let content = "";
		for (const scriptPromise of scriptsPromises) {
			content += await scriptPromise;
		}
		return content;
	}

	/*
	 * Copyright 2010-2020 Gildas Lormeau
	 * contact : gildas.lormeau <at> gmail.com
	 * 
	 * This file is part of SingleFile.
	 *
	 *   The code in this file is free software: you can redistribute it and/or 
	 *   modify it under the terms of the GNU Affero General Public License 
	 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
	 *   of the License, or (at your option) any later version.
	 * 
	 *   The code in this file is distributed in the hope that it will be useful, 
	 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
	 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
	 *   General Public License for more details.
	 *
	 *   As additional permission under GNU AGPL version 3 section 7, you may 
	 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
	 *   AGPL normally required by section 4, provided you include this license 
	 *   notice and a URL through which recipients can access the Corresponding 
	 *   Source.
	 */

	const referrers = new Map();
	const REQUEST_ID_HEADER_NAME = "x-single-file-request-id";
	const MAX_CONTENT_SIZE = 8 * (1024 * 1024);

	// browser.runtime.onMessage.addListener((message, sender) => {
	// 	if (message.method && message.method.startsWith("singlefile.fetch")) {
	// 		return new Promise(resolve => {
	// 			onRequest(message, sender)
	// 				.then(resolve)
	// 				.catch(error => resolve({ error: error && error.toString() }));
	// 		});
	// 	}
	// });

	async function onRequest(message) {
		if (message.method == "singlefile.fetch") {
			try {
				const response = await fetchResource$1(message.url, { referrer: message.referrer, headers: message.headers });
				return sendResponse(message.requestId, response);
			} catch (error) {
				return sendResponse(message.requestId, { error: error.message, arrray: [] });
			}
		} else if (message.method == "singlefile.fetchFrame" && window.frameId && window.frameId == message.frameId) {
			// return browser.tabs.sendMessage(sender.tab.id, message); // 发送到内容脚本
			onFetchFrame(message);
			return message
		}
	}

	async function sendResponse(requestId, response) {
		for (let blockIndex = 0; blockIndex * MAX_CONTENT_SIZE <= response.array.length; blockIndex++) {
			const message = {
				method: "singlefile.fetchResponse",
				requestId,
				headers: response.headers,
				status: response.status,
				error: response.error
			};
			message.truncated = response.array.length > MAX_CONTENT_SIZE;
			if (message.truncated) {
				message.finished = (blockIndex + 1) * MAX_CONTENT_SIZE > response.array.length;
				message.array = response.array.slice(blockIndex * MAX_CONTENT_SIZE, (blockIndex + 1) * MAX_CONTENT_SIZE);
			} else {
				message.array = response.array;
			}
			// await browser.tabs.sendMessage(tabId, message); // 后台脚本向内容脚本通信
			return onFetchResponse(message);
		}
		return {};
	}

	function fetchResource$1(url, options = {}, includeRequestId) {
		return new Promise((resolve, reject) => {
			const xhrRequest = new XMLHttpRequest();
			xhrRequest.withCredentials = true;
			xhrRequest.responseType = "arraybuffer";
			xhrRequest.onerror = event => reject(new Error(event.detail));
			xhrRequest.onreadystatechange = () => {
				if (xhrRequest.readyState == XMLHttpRequest.DONE) {
					// TODO: 防止请求时报错。
					if (xhrRequest.status || xhrRequest?.response?.byteLength) {
						if ((xhrRequest.status == 401 || xhrRequest.status == 403 || xhrRequest.status == 404) && !includeRequestId) {
							fetchResource$1(url, options, true)
								.then(resolve)
								.catch(reject);
						} else {
							resolve({
								arrayBuffer: xhrRequest.response,
								array: Array.from(new Uint8Array(xhrRequest.response)),
								headers: { "content-type": xhrRequest.getResponseHeader("Content-Type") },
								status: xhrRequest.status
							});
						}
					} else {
						reject(new Error("Empty response"));
					}
				}
			};
			xhrRequest.open("GET", url, true);
			if (options.headers) {
				for (const entry of Object.entries(options.headers)) {
					xhrRequest.setRequestHeader(entry[0], entry[1]);
				}
			}
			if (includeRequestId) {
				const randomId = String(Math.random()).substring(2);
				setReferrer(randomId, options.referrer);
				xhrRequest.setRequestHeader(REQUEST_ID_HEADER_NAME, randomId);
			}
			xhrRequest.send();
		});
	}

	function setReferrer(requestId, referrer) {
		referrers.set(requestId, referrer);
	}

	/*
	 * Copyright 2010-2020 Gildas Lormeau
	 * contact : gildas.lormeau <at> gmail.com
	 * 
	 * This file is part of SingleFile.
	 *
	 *   The code in this file is free software: you can redistribute it and/or 
	 *   modify it under the terms of the GNU Affero General Public License 
	 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
	 *   of the License, or (at your option) any later version.
	 * 
	 *   The code in this file is distributed in the hope that it will be useful, 
	 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
	 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
	 *   General Public License for more details.
	 *
	 *   As additional permission under GNU AGPL version 3 section 7, you may 
	 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
	 *   AGPL normally required by section 4, provided you include this license 
	 *   notice and a URL through which recipients can access the Corresponding 
	 *   Source.
	 */

	const FETCH_REQUEST_EVENT = "single-filez-request-fetch";
	const FETCH_ACK_EVENT = "single-filez-ack-fetch";
	const FETCH_RESPONSE_EVENT = "single-filez-response-fetch";
	const ERR_HOST_FETCH = "Host fetch error (SingleFileZ)";
	const HOST_FETCH_MAX_DELAY = 2500;
	const USE_HOST_FETCH = Boolean(window.wrappedJSObject);

	const fetch$1 = (url, options) => window.fetch(url, options);

	let requestId = 0, pendingResponses = new Map();

	// browser.runtime.onMessage.addListener(message => {
	// 	if (message.method == "singlefile.fetchFrame" && window.frameId && window.frameId == message.frameId) {
	// 		return onFetchFrame(message);
	// 	}
	// 	if (message.method == "singlefile.fetchResponse") {
	// 		return onFetchResponse(message);
	// 	}
	// });

	async function onFetchFrame(message) {
		try {
			const response = await fetch$1(message.url, { cache: "force-cache", headers: message.headers });
			return {
				status: response.status,
				headers: [...response.headers],
				array: Array.from(new Uint8Array(await response.arrayBuffer()))
			};
		} catch (error) {
			return {
				error: error && error.toString()
			};
		}
	}

	async function onFetchResponse(message) {
		const pendingResponse = pendingResponses.get(message.requestId);
		if (pendingResponse) {
			if (message.error) {
				pendingResponse.reject(new Error(message.error));
				pendingResponses.delete(message.requestId);
			} else {
				if (message.truncated) {
					if (pendingResponse.array) {
						pendingResponse.array = pendingResponse.array.concat(message.array);
					} else {
						pendingResponse.array = message.array;
						pendingResponses.set(message.requestId, pendingResponse);
					}
					if (message.finished) {
						message.array = pendingResponse.array;
					}
				}
				if (!message.truncated || message.finished) {
					pendingResponse.resolve({
						status: message.status,
						headers: { get: headerName => message.headers && message.headers[headerName] },
						arrayBuffer: async () => new Uint8Array(message.array).buffer
					});
					pendingResponses.delete(message.requestId);
				}
			}
		}
		return {};
	}

	async function hostFetch(url, options) {
		const result = new Promise((resolve, reject) => {
			document.dispatchEvent(new CustomEvent(FETCH_REQUEST_EVENT, { detail: JSON.stringify({ url, options }) }));
			document.addEventListener(FETCH_ACK_EVENT, onAckFetch, false);
			document.addEventListener(FETCH_RESPONSE_EVENT, onResponseFetch, false);
			const timeout = setTimeout(() => {
				removeListeners();
				reject(new Error(ERR_HOST_FETCH));
			}, HOST_FETCH_MAX_DELAY);

			function onResponseFetch(event) {
				if (event.detail) {
					if (event.detail.url == url) {
						removeListeners();
						if (event.detail.response) {
							resolve({
								status: event.detail.status,
								headers: new Map(event.detail.headers),
								arrayBuffer: async () => event.detail.response
							});
						} else {
							reject(event.detail.error);
						}
					}
				} else {
					reject();
				}
			}

			function onAckFetch() {
				clearTimeout(timeout);
			}

			function removeListeners() {
				document.removeEventListener(FETCH_RESPONSE_EVENT, onResponseFetch, false);
				document.removeEventListener(FETCH_ACK_EVENT, onAckFetch, false);
			}
		});
		try {
			return await result;
		} catch (error) {
			if (error && error.message == ERR_HOST_FETCH) {
				return fetch$1(url, options);
			} else {
				throw error;
			}
		}
	}

	// 在扩展中请求后，我们拿到结构如何处理的
	async function fetchResource(url, options = {}) {
		try {
			const fetchOptions = { cache: "force-cache", headers: options.headers };
			return await (options.referrer && USE_HOST_FETCH ? hostFetch(url, fetchOptions) : fetch$1(url, fetchOptions));
		}
		catch (error) {
			requestId++;
			const promise = new Promise((resolve, reject) => pendingResponses.set(requestId, { resolve, reject }));
			// await sendMessage({ method: "singlefile.fetch", url, requestId, referrer: options.referrer, headers: options.headers });
			new Promise(resolve => {
				onRequest({ method: "singlefile.fetch", url, requestId, referrer: options.referrer, headers: options.headers })
					.then(resolve)
					.catch(error => resolve({ error: error && error.toString() }));
			});
			return promise;
		}
	}

	async function frameFetch(url, options) {
		// const response = await sendMessage({ method: "singlefile.fetchFrame", url, frameId: options.frameId, referrer: options.referrer, headers: options.headers });
		const response = await onRequest({ method: "singlefile.fetchFrame", url, frameId: options.frameId, referrer: options.referrer, headers: options.headers });
		return {
			status: response.status,
			headers: new Map(response.headers),
			arrayBuffer: async () => new Uint8Array(response.array).buffer
		};
	}

	// async function sendMessage(message) {
	// 	const response = await browser.runtime.sendMessage(message);
	// 	if (!response || response.error) {
	// 		throw new Error(response && response.error && response.error.toString());
	// 	} else {
	// 		return response;
	// 	}
	// }

	/*
	 * Copyright 2010-2020 Gildas Lormeau
	 * contact : gildas.lormeau <at> gmail.com
	 * 
	 * This file is part of SingleFile.
	 *
	 *   The code in this file is free software: you can redistribute it and/or 
	 *   modify it under the terms of the GNU Affero General Public License 
	 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
	 *   of the License, or (at your option) any later version.
	 * 
	 *   The code in this file is distributed in the hope that it will be useful, 
	 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
	 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
	 *   General Public License for more details.
	 *
	 *   As additional permission under GNU AGPL version 3 section 7, you may 
	 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
	 *   AGPL normally required by section 4, provided you include this license 
	 *   notice and a URL through which recipients can access the Corresponding 
	 *   Source.
	 */

	function injectScript(tabId, options) {
		return inject(tabId, options);
	}

	function getPageData(options, doc, win, initOptions = { fetch: fetchResource, frameFetch }) {
		return globalThis.singlefile.getPageData(options, initOptions, doc, win);
	}


	async function downloadPage(pageData, options) {
		debugger
		if (options.includeBOM) {
			pageData.content = "\ufeff" + pageData.content;
		}
		const selizeData = await serialize(pageData);
		const blobURL = URL.createObjectURL(new Blob([selizeData], { type: "application/octet-stream" }));
		// const blobURL = URL.createObjectURL(new Blob([await serialize(pageData)], { type: "application/octet-stream" }));
		const embeddedImage = options.embeddedImage;
		const message = {
			method: "downloads.download",
			taskId: options.taskId,
			insertTextBody: options.insertTextBody,
			confirmFilename: options.confirmFilename,
			filenameConflictAction: options.filenameConflictAction,
			filename: pageData.filename,
			saveToGDrive: options.saveToGDrive,
			saveToDropbox: options.saveToDropbox,
			saveWithWebDAV: options.saveWithWebDAV,
			webDAVURL: options.webDAVURL,
			webDAVUser: options.webDAVUser,
			webDAVPassword: options.webDAVPassword,
			saveToGitHub: options.saveToGitHub,
			githubToken: options.githubToken,
			githubUser: options.githubUser,
			githubRepository: options.githubRepository,
			githubBranch: options.githubBranch,
			forceWebAuthFlow: options.forceWebAuthFlow,
			filenameReplacementCharacter: options.filenameReplacementCharacter,
			openEditor: options.openEditor,
			openSavedPage: options.openSavedPage,
			compressHTML: options.compressHTML,
			backgroundSave: options.backgroundSave,
			bookmarkId: options.bookmarkId,
			replaceBookmarkURL: options.replaceBookmarkURL,
			applySystemTheme: options.applySystemTheme,
			defaultEditorMode: options.defaultEditorMode,
			includeInfobar: options.includeInfobar,
			warnUnsavedPage: options.warnUnsavedPage,
			createRootDirectory: options.createRootDirectory,
			selfExtractingArchive: options.selfExtractingArchive,
			embeddedImage: embeddedImage ? Array.from(embeddedImage) : null,
			preventAppendedData: options.preventAppendedData,
			extractDataFromPage: options.extractDataFromPage,
			insertCanonicalLink: options.insertCanonicalLink,
			insertMetaNoIndex: options.insertMetaNoIndex,
			password: options.password,
			foregroundSave: options.foregroundSave,
			blobURL,
			// pageData
			url: location.href
		};
		// TODO: 拿到页面blob后，向后台发送下载页面的消息
		debugger
		// const downloadInfo = {
		// 	url: pageData.url,
		// 	saveAs: options.confirmFilename,
		// 	filename: pageData.filename,
		// 	conflictAction: options.filenameConflictAction
		// };
		// 发送消息，下载
		// const result = await browser.runtime.sendMessage(message);
		// await download(message);
		chrome.runtime.sendMessage({
			type: "data",
			data: message,
			// options
		});
		// const data = {
		// 	url: pageData.url,
		// 	saveAs: options.confirmFilename,
		// 	filename: pageData.filename,
		// 	conflictAction: options.filenameConflictAction
		// };
		// browser.downloads.download(data);
		// URL.revokeObjectURL(blobURL);
		// if (result.error) {
		// 	message.embeddedImage = embeddedImage;
		// 	message.blobURL = null;
		// 	message.pageData = pageData;
		// 	let data, indexData = 0;
		// 	const dataArray = await serialize(message);
		// 	do {
		// 		data = Array.from(dataArray.slice(indexData, indexData + MAX_CONTENT_SIZE));
		// 		indexData += MAX_CONTENT_SIZE;
		// 		await browser.runtime.sendMessage({
		// 			method: "downloads.download",
		// 			data
		// 		});
		// 	} while (data.length);
		// 	await browser.runtime.sendMessage({ method: "downloads.download" });
		// }
		// if (options.backgroundSave) {
		// 	await browser.runtime.sendMessage({ method: "downloads.end", taskId: options.taskId });
		// }
	}

	const options = {
		backEnd: 'webdriver-chromium',
		acceptHeaders: {
			font: 'application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8',
			image: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
			stylesheet: 'text/css,*/*;q=0.1',
			script: '*/*',
			document: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
		},
		blockMixedContent: false,
		browserServer: '',
		browserHeadless: true,
		browserExecutablePath: '',
		browserWidth: 1280,
		browserHeight: 720,
		browserLoadMaxTime: 60000,
		browserWaitDelay: 0,
		browserWaitUntil: 'networkidle0',
		browserWaitUntilFallback: true,
		browserDebug: false,
		browserArgs: '',
		browserStartMinimized: false,
		browserCookiesFile: '',
		browserIgnoreInsecureCerts: false,
		browserFreezePrototypes: false,
		compressCSS: undefined,
		compressHTML: undefined,
		dumpContent: false,
		filenameTemplate: '%if-empty<{page-title}|No title> ({date-locale} {time-locale}).{filename-extension}',
		filenameConflictAction: 'uniquify',
		filenameReplacementCharacter: '_',
		filenameMaxLength: 192,
		filenameMaxLengthUnit: 'bytes',
		replaceEmojisInFilename: false,
		httpProxyServer: '',
		httpProxyUsername: '',
		httpProxyPassword: '',
		includeInfobar: false,
		insertMetaCsp: true,
		loadDeferredImages: true,
		loadDeferredImagesDispatchScrollEvent: false,
		loadDeferredImagesMaxIdleTime: 1500,
		loadDeferredImagesKeepZoomLevel: false,
		loadDeferredImagesBeforeFrames: false,
		maxParallelWorkers: 8,
		maxResourceSizeEnabled: false,
		maxResourceSize: 10,
		moveStylesInHead: false,
		outputDirectory: '',
		password: '',
		removeHiddenElements: true,
		removeUnusedStyles: true,
		removeUnusedFonts: true,
		removeSavedDate: false,
		removeFrames: false,
		blockScripts: true,
		blockAudios: true,
		blockVideos: true,
		removeAlternativeFonts: true,
		removeAlternativeMedias: true,
		removeAlternativeImages: true,
		saveOriginalUrls: false,
		saveRawPage: false,
		webDriverExecutablePath: '',
		userScriptEnabled: true,
		includeBOM: undefined,
		crawlLinks: false,
		crawlInnerLinksOnly: true,
		crawlRemoveUrlFragment: true,
		crawlMaxDepth: 1,
		crawlExternalLinksMaxDepth: 1,
		insertTextBody: false,
		createRootDirectory: false,
		selfExtractingArchive: true,
		extractDataFromPage: true,
		preventAppendedData: false,
		url: '',
		output: '',
		backgroundSave: true,
		crawlReplaceURLs: undefined,
		crawlRemoveURLFragment: true,
		insertMetaCSP: true,
		saveOriginalURLs: false,
		httpHeaders: {},
		browserCookies: [],
		browserScripts: [],
		browserStylesheets: [],
		crawlRewriteRules: [],
		emulateMediaFeatures: []
	};

	window.options = options;
	window.getPageData = getPageData;
	window.downloadPage = downloadPage;

	// TODO: 和这个插件进行通信然后调用这段代码就可以了
	window.getPageMirrorImage = function() {
		window.getPageData(window.options).then(res => {
			window.downloadPage(res, window.options)
		})
	}
	// async function download(message) {
	// 	const pageData = message.pageData;
	// 	debugger
	// 	// TODO: 这部分逻辑需要写在后台脚本中，否者会出现跨域。
	// 	const blob = await singlefile.processors.compression.process(pageData, {
	// 		insertTextBody: message.insertTextBody,
	// 		url: pageData.url || location.href,
	// 		createRootDirectory: message.createRootDirectory,
	// 		// tabId,
	// 		selfExtractingArchive: message.selfExtractingArchive,
	// 		extractDataFromPage: message.extractDataFromPage,
	// 		preventAppendedData: message.preventAppendedData,
	// 		insertCanonicalLink: message.insertCanonicalLink,
	// 		insertMetaNoIndex: message.insertMetaNoIndex,
	// 		password: message.password,
	// 		embeddedImage: message.embeddedImage
	// 	});
	// 	if (message.backgroundSave) {
	// 		message.url = URL.createObjectURL(blob);
	// 		await downloadPage2(message, {
	// 			confirmFilename: message.confirmFilename,
	// 			incognito: tab.incognito,
	// 			filenameConflictAction: message.filenameConflictAction,
	// 			filenameReplacementCharacter: message.filenameReplacementCharacter,
	// 			bookmarkId: message.bookmarkId,
	// 			replaceBookmarkURL: message.replaceBookmarkURL,
	// 			includeInfobar: message.includeInfobar
	// 		});
	// 	} 
	// 	// else {
	// 	// 	await downloadPageForeground(message.taskId, message.filename, blob, tabId);
	// 	// }
	// }

	// // 下载页面
	// async function downloadPage2(pageData, options) {
	// 	debugger
	// 	const downloadInfo = {
	// 		url: pageData.url,
	// 		saveAs: options.confirmFilename,
	// 		filename: pageData.filename,
	// 		conflictAction: options.filenameConflictAction
	// 	};
	// 	if (options.incognito) {
	// 		downloadInfo.incognito = true;
	// 	}
	// 	// chrome.downloads.download
	// 	// TODO: 这里发送消息
	// 	// const downloadData = await download(downloadInfo, options.filenameReplacementCharacter);
	// 	// const downloadData = await download(downloadInfo, options.filenameReplacementCharacter);
	// 	chrome.runtime.sendMessage({
	// 		type: "downloads.download",
	// 		data: downloadInfo
	// 	});
	// 	if (downloadData.filename) {
	// 		let url = downloadData.filename;
	// 		if (!url.startsWith("file:")) {
	// 			if (url.startsWith("/")) {
	// 				url = url.substring(1);
	// 			}
	// 			url = "file:///" + encodeSharpCharacter(url);
	// 		}
	// 		return { url };
	// 	}
	// }


		/* global TextEncoder, TextDecoder */

	const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
	const TYPE_REFERENCE = 0;
	const SPECIAL_TYPES = [TYPE_REFERENCE];
	const EMPTY_SLOT_VALUE = Symbol();

	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	const types = new Array(256);
	let typeIndex = 0;

	registerType(serializeCircularReference, parseCircularReference, testCircularReference, TYPE_REFERENCE);
	registerType(null, parseObject, testObject);
	registerType(serializeArray, parseArray, testArray);
	registerType(serializeString, parseString, testString);
	registerType(serializeTypedArray, parseFloat64Array, testFloat64Array);
	registerType(serializeTypedArray, parseFloat32Array, testFloat32Array);
	registerType(serializeTypedArray, parseUint32Array, testUint32Array);
	registerType(serializeTypedArray, parseInt32Array, testInt32Array);
	registerType(serializeTypedArray, parseUint16Array, testUint16Array);
	registerType(serializeTypedArray, parseInt16Array, testInt16Array);
	registerType(serializeTypedArray, parseUint8ClampedArray, testUint8ClampedArray);
	registerType(serializeTypedArray, parseUint8Array, testUint8Array);
	registerType(serializeTypedArray, parseInt8Array, testInt8Array);
	registerType(serializeArrayBuffer, parseArrayBuffer, testArrayBuffer);
	registerType(serializeNumber, parseNumber, testNumber);
	registerType(serializeUint32, parseUint32, testUint32);
	registerType(serializeInt32, parseInt32, testInt32);
	registerType(serializeUint16, parseUint16, testUint16);
	registerType(serializeInt16, parseInt16, testInt16);
	registerType(serializeUint8, parseUint8, testUint8);
	registerType(serializeInt8, parseInt8, testInt8);
	registerType(null, parseUndefined, testUndefined);
	registerType(null, parseNull, testNull);
	registerType(null, parseNaN, testNaN);
	registerType(serializeBoolean, parseBoolean, testBoolean);
	registerType(serializeSymbol, parseSymbol, testSymbol);
	registerType(null, parseEmptySlot, testEmptySlot);
	registerType(serializeMap, parseMap, testMap);
	registerType(serializeSet, parseSet, testSet);
	registerType(serializeDate, parseDate, testDate);
	registerType(serializeError, parseError, testError);
	registerType(serializeRegExp, parseRegExp, testRegExp);
	registerType(serializeStringObject, parseStringObject, testStringObject);
	registerType(serializeNumberObject, parseNumberObject, testNumberObject);
	registerType(serializeBooleanObject, parseBooleanObject, testBooleanObject);



	function registerType(serialize, parse, test, type) {
		if (type === undefined) {
			typeIndex++;
			if (types.length - typeIndex >= SPECIAL_TYPES.length) {
				types[types.length - typeIndex] = { serialize, parse, test };
			} else {
				throw new Error("Reached maximum number of custom types");
			}
		} else {
			types[type] = { serialize, parse, test };
		}
	}

	async function serialize(object, options) {
		const serializer = getSerializer(object, options);
		let result = new Uint8Array([]);
		for await (const chunk of serializer) {
			const previousResult = result;
			result = new Uint8Array(previousResult.length + chunk.length);
			result.set(previousResult, 0);
			result.set(chunk, previousResult.length);
		}
		return result;
	}

	class SerializerData {
		constructor(appendData, chunkSize) {
			this.stream = new WriteStream(appendData, chunkSize);
			this.objects = [];
		}

		append(array) {
			return this.stream.append(array);
		}

		flush() {
			return this.stream.flush();
		}

		addObject(value) {
			this.objects.push(testReferenceable(value) && !testCircularReference(value, this) ? value : undefined);
		}
	}

	class WriteStream {
		constructor(appendData, chunkSize) {
			this.offset = 0;
			this.appendData = appendData;
			this.value = new Uint8Array(chunkSize);
		}

		async append(array) {
			if (this.offset + array.length > this.value.length) {
				const offset = this.value.length - this.offset;
				await this.append(array.subarray(0, offset));
				await this.appendData({ value: this.value });
				this.offset = 0;
				await this.append(array.subarray(offset));
			} else {
				this.value.set(array, this.offset);
				this.offset += array.length;
			}
		}

		async flush() {
			if (this.offset) {
				await this.appendData({ value: this.value.subarray(0, this.offset), done: true });
			}
		}
	}

	function getSerializer(value, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
		let serializerData, result, setResult, iterationDone, previousResult, resolvePreviousResult;
		return {
			[Symbol.asyncIterator]() {
				return {
					next() {
						return iterationDone ? { done: iterationDone } : getResult();
					},
					return() {
						return { done: true };
					}
				};
			}
		};

		async function getResult() {
			if (resolvePreviousResult) {
				resolvePreviousResult();
			} else {
				initSerializerData().catch(() => { /* ignored */ });
			}
			initPreviousData();
			const value = await getValue();
			return { value };
		}

		async function initSerializerData() {
			initResult();
			serializerData = new SerializerData(appendData, chunkSize);
			await serializeValue(serializerData, value);
			await serializerData.flush();
		}

		function initResult() {
			result = new Promise(resolve => setResult = resolve);
		}

		function initPreviousData() {
			previousResult = new Promise(resolve => resolvePreviousResult = resolve);
		}

		async function appendData(result) {
			setResult(result);
			await previousResult;
		}

		async function getValue() {
			const { value, done } = await result;
			iterationDone = done;
			if (!done) {
				initResult();
			}
			return value;
		}
	}

	async function serializeValue(data, value) {
		const type = types.findIndex(({ test } = {}) => test && test(value, data));
		data.addObject(value);
		await data.append(new Uint8Array([type]));
		const serialize = types[type].serialize;
		if (serialize) {
			await serialize(data, value);
		}
		if (type != TYPE_REFERENCE && testObject(value)) {
			await serializeSymbols(data, value);
			await serializeOwnProperties(data, value);
		}
	}

	async function serializeSymbols(data, value) {
		const ownPropertySymbols = Object.getOwnPropertySymbols(value);
		const symbols = ownPropertySymbols.map(propertySymbol => [propertySymbol, value[propertySymbol]]);
		await serializeArray(data, symbols);
	}

	async function serializeOwnProperties(data, value) {
		if (!ArrayBuffer.isView(value)) {
			let entries = Object.entries(value);
			if (testArray(value)) {
				entries = entries.filter(([key]) => !testInteger(Number(key)));
			}
			await serializeValue(data, entries.length);
			for (const [key, value] of entries) {
				await serializeString(data, key);
				await serializeValue(data, value);
			}
		} else {
			await serializeValue(data, 0);
		}
	}

	async function serializeCircularReference(data, value) {
		const index = data.objects.indexOf(value);
		await serializeValue(data, index);
	}

	async function serializeArray(data, array) {
		await serializeValue(data, array.length);
		const notEmptyIndexes = Object.keys(array).filter(key => testInteger(Number(key))).map(key => Number(key));
		let indexNotEmptyIndexes = 0, currentNotEmptyIndex = notEmptyIndexes[indexNotEmptyIndexes];
		for (const [indexArray, value] of array.entries()) {
			if (currentNotEmptyIndex == indexArray) {
				currentNotEmptyIndex = notEmptyIndexes[++indexNotEmptyIndexes];
				await serializeValue(data, value);
			} else {
				await serializeValue(data, EMPTY_SLOT_VALUE);
			}
		}
	}

	async function serializeString(data, string) {
		const encodedString = textEncoder.encode(string);
		await serializeValue(data, encodedString.length);
		await data.append(encodedString);
	}

	async function serializeTypedArray(data, array) {
		await serializeValue(data, array.length);
		await data.append(array.constructor.name == "Uint8Array" ? array : new Uint8Array(array.buffer));
	}

	async function serializeArrayBuffer(data, arrayBuffer) {
		await serializeValue(data, arrayBuffer.byteLength);
		await data.append(new Uint8Array(arrayBuffer));
	}

	async function serializeNumber(data, number) {
		const serializedNumber = new Uint8Array(new Float64Array([number]).buffer);
		await data.append(serializedNumber);
	}

	async function serializeUint32(data, number) {
		const serializedNumber = new Uint8Array(new Uint32Array([number]).buffer);
		await data.append(serializedNumber);
	}

	async function serializeInt32(data, number) {
		const serializedNumber = new Uint8Array(new Int32Array([number]).buffer);
		await data.append(serializedNumber);
	}

	async function serializeUint16(data, number) {
		const serializedNumber = new Uint8Array(new Uint16Array([number]).buffer);
		await data.append(serializedNumber);
	}

	async function serializeInt16(data, number) {
		const serializedNumber = new Uint8Array(new Int16Array([number]).buffer);
		await data.append(serializedNumber);
	}

	async function serializeUint8(data, number) {
		const serializedNumber = new Uint8Array([number]);
		await data.append(serializedNumber);
	}

	async function serializeInt8(data, number) {
		const serializedNumber = new Uint8Array(new Int8Array([number]).buffer);
		await data.append(serializedNumber);
	}

	async function serializeBoolean(data, boolean) {
		const serializedBoolean = new Uint8Array([Number(boolean)]);
		await data.append(serializedBoolean);
	}

	async function serializeMap(data, map) {
		const entries = map.entries();
		await serializeValue(data, map.size);
		for (const [key, value] of entries) {
			await serializeValue(data, key);
			await serializeValue(data, value);
		}
	}

	async function serializeSet(data, set) {
		await serializeValue(data, set.size);
		for (const value of set) {
			await serializeValue(data, value);
		}
	}

	async function serializeDate(data, date) {
		await serializeNumber(data, date.getTime());
	}

	async function serializeError(data, error) {
		await serializeString(data, error.message);
		await serializeString(data, error.stack);
	}

	async function serializeRegExp(data, regExp) {
		await serializeString(data, regExp.source);
		await serializeString(data, regExp.flags);
	}

	async function serializeStringObject(data, string) {
		await serializeString(data, string.valueOf());
	}

	async function serializeNumberObject(data, number) {
		await serializeNumber(data, number.valueOf());
	}

	async function serializeBooleanObject(data, boolean) {
		await serializeBoolean(data, boolean.valueOf());
	}

	async function serializeSymbol(data, symbol) {
		await serializeString(data, symbol.description);
	}

	class Reference {
		constructor(index, data) {
			this.index = index;
			this.data = data;
		}

		getObject() {
			return this.data.objects[this.index];
		}
	}

	async function parseValue(data) {
		const array = await data.consume(1);
		const parserType = array[0];
		const parse = types[parserType].parse;
		const valueId = data.getObjectId();
		const result = await parse(data);
		if (parserType != TYPE_REFERENCE && testObject(result)) {
			await parseSymbols(data, result);
			await parseOwnProperties(data, result);
		}
		data.resolveObject(valueId, result);
		return result;
	}

	async function parseSymbols(data, value) {
		const symbols = await parseArray(data);
		data.setObject([symbols], symbols => symbols.forEach(([symbol, propertyValue]) => value[symbol] = propertyValue));
	}

	async function parseOwnProperties(data, object) {
		const size = await parseValue(data);
		if (size) {
			await parseNextProperty();
		}

		async function parseNextProperty(indexKey = 0) {
			const key = await parseString(data);
			const value = await parseValue(data);
			data.setObject([value], value => object[key] = value);
			if (indexKey < size - 1) {
				await parseNextProperty(indexKey + 1);
			}
		}
	}

	async function parseCircularReference(data) {
		const index = await parseValue(data);
		const result = new Reference(index, data);
		return result;
	}

	function parseObject() {
		return {};
	}

	async function parseArray(data) {
		const length = await parseValue(data);
		const array = new Array(length);
		if (length) {
			await parseNextSlot();
		}
		return array;

		async function parseNextSlot(indexArray = 0) {
			const value = await parseValue(data);
			if (!testEmptySlot(value)) {
				data.setObject([value], value => array[indexArray] = value);
			}
			if (indexArray < length - 1) {
				await parseNextSlot(indexArray + 1);
			}
		}
	}

	function parseEmptySlot() {
		return EMPTY_SLOT_VALUE;
	}

	async function parseString(data) {
		const size = await parseValue(data);
		const array = await data.consume(size);
		return textDecoder.decode(array);
	}

	async function parseFloat64Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length * 8);
		return new Float64Array(array.buffer);
	}

	async function parseFloat32Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length * 4);
		return new Float32Array(array.buffer);
	}

	async function parseUint32Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length * 4);
		return new Uint32Array(array.buffer);
	}

	async function parseInt32Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length * 4);
		return new Int32Array(array.buffer);
	}

	async function parseUint16Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length * 2);
		return new Uint16Array(array.buffer);
	}

	async function parseInt16Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length * 2);
		return new Int16Array(array.buffer);
	}

	async function parseUint8ClampedArray(data) {
		const length = await parseValue(data);
		const array = await data.consume(length);
		return new Uint8ClampedArray(array.buffer);
	}

	async function parseUint8Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length);
		return array;
	}

	async function parseInt8Array(data) {
		const length = await parseValue(data);
		const array = await data.consume(length);
		return new Int8Array(array.buffer);
	}

	async function parseArrayBuffer(data) {
		const length = await parseValue(data);
		const array = await data.consume(length);
		return array.buffer;
	}

	async function parseNumber(data) {
		const array = await data.consume(8);
		return new Float64Array(array.buffer)[0];
	}

	async function parseUint32(data) {
		const array = await data.consume(4);
		return new Uint32Array(array.buffer)[0];
	}

	async function parseInt32(data) {
		const array = await data.consume(4);
		return new Int32Array(array.buffer)[0];
	}

	async function parseUint16(data) {
		const array = await data.consume(2);
		return new Uint16Array(array.buffer)[0];
	}

	async function parseInt16(data) {
		const array = await data.consume(2);
		return new Int16Array(array.buffer)[0];
	}

	async function parseUint8(data) {
		const array = await data.consume(1);
		return new Uint8Array(array.buffer)[0];
	}

	async function parseInt8(data) {
		const array = await data.consume(1);
		return new Int8Array(array.buffer)[0];
	}

	function parseUndefined() {
		return undefined;
	}

	function parseNull() {
		return null;
	}

	function parseNaN() {
		return NaN;
	}

	async function parseBoolean(data) {
		const array = await data.consume(1);
		return Boolean(array[0]);
	}

	async function parseMap(data) {
		const size = await parseValue(data);
		const map = new Map();
		if (size) {
			await parseNextEntry();
		}
		return map;

		async function parseNextEntry(indexKey = 0) {
			const key = await parseValue(data);
			const value = await parseValue(data);
			data.setObject([key, value], (key, value) => map.set(key, value));
			if (indexKey < size - 1) {
				await parseNextEntry(indexKey + 1);
			}
		}
	}

	async function parseSet(data) {
		const size = await parseValue(data);
		const set = new Set();
		if (size) {
			await parseNextEntry();
		}
		return set;

		async function parseNextEntry(indexKey = 0) {
			const value = await parseValue(data);
			data.setObject([value], value => set.add(value));
			if (indexKey < size - 1) {
				await parseNextEntry(indexKey + 1);
			}
		}
	}

	async function parseDate(data) {
		const milliseconds = await parseNumber(data);
		return new Date(milliseconds);
	}

	async function parseError(data) {
		const message = await parseString(data);
		const stack = await parseString(data);
		const error = new Error(message);
		error.stack = stack;
		return error;
	}

	async function parseRegExp(data) {
		const source = await parseString(data);
		const flags = await parseString(data);
		return new RegExp(source, flags);
	}

	async function parseStringObject(data) {
		return new String(await parseString(data));
	}

	async function parseNumberObject(data) {
		return new Number(await parseNumber(data));
	}

	async function parseBooleanObject(data) {
		return new Boolean(await parseBoolean(data));
	}

	async function parseSymbol(data) {
		const description = await parseString(data);
		return Symbol(description);
	}

	function testCircularReference(value, data) {
		return testObject(value) && data.objects.includes(value);
	}

	function testObject(value) {
		return value === Object(value);
	}

	function testArray(value) {
		return typeof value.length == "number";
	}

	function testEmptySlot(value) {
		return value === EMPTY_SLOT_VALUE;
	}

	function testString(value) {
		return typeof value == "string";
	}

	function testFloat64Array(value) {
		return value.constructor.name == "Float64Array";
	}

	function testUint32Array(value) {
		return value.constructor.name == "Uint32Array";
	}

	function testInt32Array(value) {
		return value.constructor.name == "Int32Array";
	}

	function testUint16Array(value) {
		return value.constructor.name == "Uint16Array";
	}

	function testFloat32Array(value) {
		return value.constructor.name == "Float32Array";
	}

	function testInt16Array(value) {
		return value.constructor.name == "Int16Array";
	}

	function testUint8ClampedArray(value) {
		return value.constructor.name == "Uint8ClampedArray";
	}

	function testUint8Array(value) {
		return value.constructor.name == "Uint8Array";
	}

	function testInt8Array(value) {
		return value.constructor.name == "Int8Array";
	}

	function testArrayBuffer(value) {
		return value.constructor.name == "ArrayBuffer";
	}

	function testNumber(value) {
		return typeof value == "number";
	}

	function testUint32(value) {
		return testInteger(value) && value >= 0 && value <= 4294967295;
	}

	function testInt32(value) {
		return testInteger(value) && value >= -2147483648 && value <= 2147483647;
	}

	function testUint16(value) {
		return testInteger(value) && value >= 0 && value <= 65535;
	}

	function testInt16(value) {
		return testInteger(value) && value >= -32768 && value <= 32767;
	}

	function testUint8(value) {
		return testInteger(value) && value >= 0 && value <= 255;
	}

	function testInt8(value) {
		return testInteger(value) && value >= -128 && value <= 127;
	}

	function testInteger(value) {
		return testNumber(value) && Number.isInteger(value);
	}

	function testUndefined(value) {
		return value === undefined;
	}

	function testNull(value) {
		return value === null;
	}

	function testNaN(value) {
		return Number.isNaN(value);
	}

	function testBoolean(value) {
		return typeof value == "boolean";
	}

	function testMap(value) {
		return value instanceof Map;
	}

	function testSet(value) {
		return value instanceof Set;
	}

	function testDate(value) {
		return value instanceof Date;
	}

	function testError(value) {
		return value instanceof Error;
	}

	function testRegExp(value) {
		return value instanceof RegExp;
	}

	function testStringObject(value) {
		return value instanceof String;
	}

	function testNumberObject(value) {
		return value instanceof Number;
	}

	function testBooleanObject(value) {
		return value instanceof Boolean;
	}

	function testSymbol(value) {
		return typeof value == "symbol";
	}

	function testReferenceable(value) {
		return testObject(value) || testSymbol(value);
	}

	exports.downloadPage = downloadPage;
	exports.getPageData = getPageData;
	exports.injectScript = injectScript;

	Object.defineProperty(exports, '__esModule', { value: true });

}));
