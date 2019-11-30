/* Importing Libraries and types */
import { Red, NodeProperties } from 'node-red';
import PLM, { Byte, Packet, Utilities } from 'insteon-plm';
import { InsteonModemConfigNode } from '../../types/types';
import { Request, Response } from 'express';

/* Interfaces */
interface PLMConfigNodeProps extends NodeProperties {
	path: string;
}

/* Reconnect time settings */
let reconnectTime = 15000;

/* Exporting Node Function */
export = function(RED: Red){
	// Settings
	reconnectTime = RED.settings.serialReconnectTime ?? reconnectTime;

	// Registering node type and a constructor
	RED.nodes.registerType('insteon-modem-config', function(this: InsteonModemConfigNode, props: PLMConfigNodeProps){

		/* Creating actual node */
		RED.nodes.createNode(this, props);

		/* Saving config */
		this.path = props.path;
		this.errored = false;

		/* Setting up PLM */
		setupPLM(this);
	});

	// Setting up server to get serial nodes
	RED.httpAdmin.get(
		"/insteon-ports",                          // URL
		RED.auth.needsPermission('serial.read'),   // Permission
		getInsteonPorts                            // Get Devices as JSON
	);

	/* Server to provide the PLM's Link database
	 * The ajax call to this node must post the node_id of the modem config node
	 */
	RED.httpAdmin.post(
		"/insteon-plm-getlinks",
		RED.auth.needsPermission('serial.read'),
		(req: any, res: any) => getInsteonLinks(RED, req, res)
	);

	/* Server to link or unlink a device from the PLM's Link database
	 * The ajax call to this node must post the node_id of the modem config node
	 */
	RED.httpAdmin.post(
		"/insteon-plm-manage-device",
		RED.auth.needsPermission('serial.read'),
		(req: any, res: any) => manageDevice(RED, req, res)
	);
};

//#region Connection Functions

function setupPLM(node: InsteonModemConfigNode){

	/* Removing old PLM */
	removeOldPLM(node);

	/* Creating Insteon PLM Object */
	node.plm = new PLM(node.path);

	/* Waiting on events */
	node.on('close', () => onNodeClose(node));
	node.plm.on('connected', () => onConnected(node));
	node.plm.on('disconnected', () => onDisconnected(node));
	node.plm.on('error', (error: Error) => onError(node, error));
	node.plm.on('packet', (packet: Packet.Packet) => onPacket(node, packet));
}

//#endregion

//#region Event Functions

function onConnected(node: InsteonModemConfigNode){
	node.log('Connected');

	node.errored = false;

	/* Emitting Status */
	node.emit('connected');
}
function onDisconnected(node: InsteonModemConfigNode){
	node.log('Disconnected');

	/* Emitting Status */
	node.emit('disconnected');

	/* Setting up reconnection */
	setTimeout(_ => setupPLM(node), reconnectTime)
}
function onError(node: InsteonModemConfigNode, error: Error){

	if(!node.errored){
		node.errored = true;
		node.log(`Error: ${error.message}`);
	}

	/* Emitting Status */
	node.emit('error', error);

	/* Setting up reconnection */
	setTimeout(_ => setupPLM(node), reconnectTime);
}
function onPacket(node: InsteonModemConfigNode, packet: Packet.Packet){
	/* Emitting Packet */
	node.emit('packet', packet);
}
function onNodeClose(node: InsteonModemConfigNode){
	/* Closing PLM */
	removeOldPLM(node);
}

//#endregion

//#region Server Functions

async function getInsteonPorts(req: Request, res: Response){

	try{
		const devices = await PLM.getPlmDevices();

		res.json(devices);
	}
	catch(e){
		res.status(500).send({message: 'An error has occured', caught: e.message});
	}

}
async function getInsteonLinks(RED: Red, req: Request, res: Response){
	/* Lookup the PLM Config Node by the node ID that was passed in via the request */
	try{
		let PLMConfigNode = validatePLMConnection(RED, req.body.id);

		/* Send the links back to the client */
		res.json(PLMConfigNode?.plm?.links ?? []);
	}
	catch(e){
		res.status(500).send({message: 'An error has occured', caught: e.message});
	}
}
async function manageDevice(RED: Red, req: Request, res: Response){
	try{
		let PLMConfigNode = validatePLMConnection(RED, req.body.id);

		/* Validate the device address */
		let address = Utilities.toAddressArray(req.body.address) as Byte[];
		if(address.length !== 3){
			// Server side failure
			res.status(400);
			res.json({
				message: "Invalid Insteon device address. Please use format `AA.BB.CC`"
			});
			return;
		}

		let result: any;
		let messageVerb = "";
		if(req.body.action === 'addNewDevice'){
			result = await PLMConfigNode?.plm?.linkDevice(address);
			let messageVerb = "linked";
			/* Get device info after we've added it */
			// let deviceInfo = await PLMConfigNode.plm!.queryDeviceInfo(address);
		}else if(req.body.action === 'removeDevice'){
			/* Get device info before we remove it */
			// let deviceInfo = await PLMConfigNode.plm!.queryDeviceInfo(address);
			result = await PLMConfigNode?.plm?.unlinkDevice(address);
			messageVerb = "unlinked";
		}else{
			throw new Error("Invalid action");
		}

		let links = await PLMConfigNode?.plm?.syncLinks();

		res.json({
			result: result,
			links: links,
			// deviceInfo: deviceInfo,
			// message: `Device ${deviceInfo.description} was ${messageVerb}`
			message: `Device was ${messageVerb}`
		});

	}
	catch(e){
		res.status(500).send({message: 'An error has occured', caught: e.message});
	}
}

//#endregion

//#region Clean up functions

function removeOldPLM(node: InsteonModemConfigNode){
	// Removing all listeners
	node.plm?.removeAllListeners();

	// Closing connection
	if(node.plm?.connected)
		node.plm.close();

	// Killing ref
	delete node.plm;
}

//#endregion

//#region Utlity Functions

/* Function that takes a node.id and returns the node if it is valid
 * The node must be a PLMConfig node, and the PLM must be connected
 */
function validatePLMConnection(RED: Red, configNodeId: string){
	/* Lookup the PLM Config Node by the node ID that was passed in via the request */
	let PLMConfigNode = RED.nodes.getNode(configNodeId) as InsteonModemConfigNode;

	/* Validate that the nodeId received is referencing a PLMConfig node */
	if(PLMConfigNode == null || PLMConfigNode.type !== 'insteon-modem-config' )
		throw Error("Invalid config node specified.");

	/* Check to see if the Config Node is connected to the PLM. If the node hasn't been deployed yet, it won't be connected
	 * The best thing would be to connect, get/return the links then disconnect, but for now we will just send an error
	 */
	if(PLMConfigNode.plm === null || !PLMConfigNode.plm?.connected)
		throw Error("The PLM is not connected. Cannot load links.");

	return PLMConfigNode;
}

//#endregion