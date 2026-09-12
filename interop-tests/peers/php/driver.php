<?php

declare(strict_types=1);

// HTTP-driven php-smpp ESME: one connection at a time (php-smpp itself blocks synchronously on
// every send and read), holding named client sockets open across requests the way the Java and
// Python drivers do (see AGENTS.md). No composer: a tiny PSR-4-shaped autoloader over the fork's
// own src/ tree, cloned at a pinned commit during the image build.

spl_autoload_register(function (string $class): void {
	$prefix = 'smpp\\';

	if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
		return;
	}

	$relative = substr($class, strlen($prefix));
	$path = '/app/smpp-src/' . str_replace('\\', '/', $relative) . '.php';

	if (is_file($path)) {
		require $path;
	}
});

use smpp\Address;
use smpp\Client;
use smpp\DeliveryReceipt;
use smpp\exceptions\SmppException;
use smpp\helpers\GsmEncoderHelper;
use smpp\SMPP;
use smpp\transport\Socket;

$targetHost = $argv[1] ?? 'node';
$targetPort = (int) ($argv[2] ?? 2775);

/** @var array<string, Client> */
$clients = [];

function jsonBody(): array
{
	$raw = file_get_contents('php://input');

	return $raw === '' || $raw === false ? [] : (json_decode($raw, true) ?? []);
}

function respond(int $status, array $payload): void
{
	http_response_code($status);
	header('Content-Type: application/json');
	echo json_encode($payload);
}

function encodeBody(string $text, int $dataCoding): string
{
	if ($dataCoding === SMPP::DATA_CODING_DEFAULT) {
		return GsmEncoderHelper::utf8_to_gsm0338($text);
	}

	if ($dataCoding === SMPP::DATA_CODING_ISO8859_1) {
		return mb_convert_encoding($text, 'ISO-8859-1', 'UTF-8');
	}

	// UCS2: sendSMS() converts internally, so the raw UTF-8 text passes straight through here.
	return $text;
}

// Inverse of GsmEncoderHelper's dict, for decoding what this driver receives - reusing the peer's
// own table so a mismatch against what was sent is the peer's own encode/decode disagreeing with
// itself, not this driver guessing at the real GSM 03.38 one.
function gsmDecode(string $data): string
{
	static $reverse = null;

	if ($reverse === null) {
		$reverse = [];

		foreach (gsmEncodeDict() as $char => $bytes) {
			$reverse[$bytes] = $char;
		}
	}

	$result = '';
	$length = strlen($data);
	$i = 0;

	while ($i < $length) {
		if ($data[$i] === "\x1B" && $i + 1 < $length) {
			$pair = substr($data, $i, 2);
			$result .= $reverse[$pair] ?? '?';
			$i += 2;
		} else {
			$result .= $reverse[$data[$i]] ?? $data[$i];
			$i += 1;
		}
	}

	return $result;
}

// The dict inside utf8_to_gsm0338() is a local literal, not a class constant - re-derived once by
// encoding every basic-table/extension character singly and reading back what came out, rather
// than duplicating the private table here.
function gsmEncodeDict(): array
{
	static $dict = null;

	if ($dict !== null) {
		return $dict;
	}

	$dict = [];
	$candidates = ['@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', 'Ø', 'ø', 'Å', 'å', 'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', 'Æ', 'æ', 'ß', 'É', '¡', 'Ä', 'Ö', 'Ñ', 'Ü', '§', '¿', 'ä', 'ö', 'ñ', 'ü', 'à', '^', '{', '}', '\\', '[', '~', ']', '|', '€'];

	foreach ($candidates as $char) {
		$encoded = GsmEncoderHelper::utf8_to_gsm0338($char);

		if ($encoded !== $char) {
			$dict[$char] = $encoded;
		}
	}

	return $dict;
}

function decodeBody(string $data, int $dataCoding): string
{
	if ($dataCoding === SMPP::DATA_CODING_UCS2) {
		return mb_convert_encoding($data, 'UTF-8', 'UCS-2BE');
	}

	if ($dataCoding === SMPP::DATA_CODING_ISO8859_1) {
		return mb_convert_encoding($data, 'UTF-8', 'ISO-8859-1');
	}

	return gsmDecode($data);
}

function doBind(array $body): array
{
	global $clients, $targetHost, $targetPort;

	$name = $body['name'];
	$recvTimeoutMs = (int) ($body['recvTimeoutMs'] ?? 5000);

	$transport = new Socket([$targetHost], $targetPort);
	$transport->setRecvTimeout($recvTimeoutMs);
	$transport->open();

	$client = new Client($transport);
	Client::$smsNullTerminateOctetStrings = false;

	if (isset($body['interfaceVersion'])) {
		Client::$interfaceVersion = (int) $body['interfaceVersion'];
	}

	$systemId = $body['systemId'];
	$password = $body['password'];

	switch ($body['mode']) {
		case 'transmitter':
			$client->bindTransmitter($systemId, $password);
			break;
		case 'receiver':
			$client->bindReceiver($systemId, $password);
			break;
		default:
			$client->bindTransceiver($systemId, $password);
	}

	$clients[$name] = $client;

	return ['ok' => true];
}

function doUnbind(array $body): array
{
	global $clients;

	$clients[$body['name']]->close();
	unset($clients[$body['name']]);

	return ['ok' => true];
}

function doEnquireLink(array $body): array
{
	global $clients;

	$clients[$body['name']]->enquireLink();

	return ['ok' => true];
}

/** Single, non-CSMS submit - used by the refusal and bind-direction scenarios. */
function doSubmit(array $body): array
{
	global $clients;

	$client = $clients[$body['name']];
	$dataCoding = (int) ($body['dataCoding'] ?? SMPP::DATA_CODING_DEFAULT);
	$message = encodeBody($body['text'], $dataCoding);
	$from = new Address($body['from']);
	$to = new Address($body['to']);

	try {
		$messageId = $client->sendSMS($from, $to, $message, null, $dataCoding);

		return ['messageId' => $messageId, 'ok' => true];
	} catch (SmppException $e) {
		return ['ok' => false, 'status' => $e->getCode()];
	}
}

/** One message in each of the three CSMS spellings; Client::$csmsMethod is process-global, so this
 * driver serves one request at a time by construction (see the top-of-file note). */
function doSendLong(array $body): array
{
	global $clients;

	$client = $clients[$body['name']];
	Client::$csmsMethod = (int) $body['csmsMethod'];
	$message = encodeBody($body['text'], SMPP::DATA_CODING_DEFAULT);
	$from = new Address($body['from']);
	$to = new Address($body['to']);

	try {
		$messageId = $client->sendSMS($from, $to, $message, null, SMPP::DATA_CODING_DEFAULT);

		return ['lastMessageId' => $messageId, 'ok' => true];
	} catch (SmppException $e) {
		return ['ok' => false, 'status' => $e->getCode()];
	}
}

function doReceive(array $body): array
{
	global $clients;

	$client = $clients[$body['name']];
	$sms = $client->readSMS();

	if ($sms === false) {
		return ['ok' => true, 'received' => false];
	}

	return [
		'dataCoding' => $sms->dataCoding,
		'esmClass' => $sms->esmClass,
		'from' => $sms->source->value,
		'hex' => bin2hex($sms->message),
		'isReceipt' => $sms instanceof DeliveryReceipt,
		'ok' => true,
		'received' => true,
		'text' => decodeBody($sms->message, $sms->dataCoding),
		'to' => $sms->destination->value,
	];
}

const ROUTES = [
	'/bind' => 'doBind',
	'/enquireLink' => 'doEnquireLink',
	'/receive' => 'doReceive',
	'/sendLong' => 'doSendLong',
	'/submit' => 'doSubmit',
	'/unbind' => 'doUnbind',
];

// Minimal single-connection HTTP server: no framework, one request handled fully before the next
// is accepted - which is exactly what a synchronous, blocking SMPP client needs (see top note).
$listen = stream_socket_server('tcp://0.0.0.0:8080', $errno, $errstr);

if ($listen === false) {
	fwrite(STDERR, "listen failed: $errstr\n");
	exit(1);
}

fwrite(STDERR, "php-smpp driver listening on 8080, target $targetHost:$targetPort\n");

while (true) {
	$conn = @stream_socket_accept($listen, -1);

	if ($conn === false) {
		continue;
	}

	$requestLine = fgets($conn);
	$method = 'GET';
	$path = '/';

	if ($requestLine !== false && preg_match('#^(\\S+)\\s+(\\S+)#', $requestLine, $m)) {
		$method = $m[1];
		$path = parse_url($m[2], PHP_URL_PATH) ?? '/';
	}

	$contentLength = 0;

	while (($line = fgets($conn)) !== false && trim($line) !== '') {
		if (preg_match('/^Content-Length:\\s*(\\d+)/i', $line, $m)) {
			$contentLength = (int) $m[1];
		}
	}

	$rawBody = '';

	while (strlen($rawBody) < $contentLength) {
		$chunk = fread($conn, $contentLength - strlen($rawBody));

		if ($chunk === false || $chunk === '') {
			break;
		}

		$rawBody .= $chunk;
	}
	$body = $rawBody === '' || $rawBody === false ? [] : (json_decode($rawBody, true) ?? []);

	if ($path === '/health') {
		$payload = ['ok' => true];
		$status = 200;
	} elseif (isset(ROUTES[$path])) {
		try {
			$payload = ROUTES[$path]($body);
			$status = 200;
		} catch (Throwable $e) {
			$payload = ['error' => get_class($e) . ': ' . $e->getMessage()];
			$status = 500;
		}
	} else {
		$payload = ['error' => 'no such route'];
		$status = 404;
	}

	$json = json_encode($payload);
	$statusText = $status === 200 ? 'OK' : ($status === 404 ? 'Not Found' : 'Internal Server Error');
	fwrite(
		$conn,
		"HTTP/1.1 $status $statusText\r\nContent-Type: application/json\r\nContent-Length: "
			. strlen($json) . "\r\nConnection: close\r\n\r\n" . $json
	);
	fclose($conn);
}
