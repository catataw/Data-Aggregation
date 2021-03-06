"use strict";
const datafire = require('datafire');
const request = require('request');
const express = require('express');
const setup = require('./setup');
const config = require('./config.json');
const webUrl = require('../auth');
const logger = require('./winston');
const shopifyAPI = require('shopify-node-api');
const app = express();
app.listen(3333, () => logger.accessLog.info('Listening for redirect URL on port: 3333'));

//WARN need to have integration,clientId ... variables here or else they won't update in the app.get method;
let state = null;
let integration;
let accountName;
let clientId;
let clientSecret;
let shop;

let getShopifyURL = (shop, apikey, secret) => {
    let shopify = new shopifyAPI({
        shop: shop,
        shopify_api_key: apikey,
        shopify_shared_secret: secret,
        shopify_scope: 'read_content,read_themes,read_products,read_product_listings,read_customers,read_orders,read_draft_orders,read_inventory,read_locations,read_script_tags,read_fulfillments,read_shipping,read_checkouts,read_reports,read_price_rules,read_marketing_events,read_resource_feedbacks,read_shopify_payments_payouts,unauthenticated_read_product_listings,unauthenticated_write_checkouts,unauthenticated_read_content',
        redirect_uri: 'http://localhost:3333',
        nonce: '123',
        verbose: false,
    });
    return {
        url: shopify.buildAuthURL(),
        shopify: shopify
    }

};
let getOAuthURL = (clientId, redirect, integration) => {
    let scope = webUrl[integration].scopes;
    let url = webUrl[integration].code;
    state = Math.random();
    url += '?response_type=code';
    url += '&redirect_uri=' + encodeURIComponent(redirect);
    url += '&client_id=' + encodeURIComponent(clientId);
    let temp = "";
    if (scope != undefined) {
        for (let key in scope) {
            if (scope.hasOwnProperty(key)) {
                temp += key + ' ';
            }
        }
        if (integration === "hubspot") { // it won't work unless the addition space (%20) is removed at the end of the scope parameter
            let str = encodeURIComponent(temp).toString();
            str = str.slice(0, -3);
            url += '&scope=' + str;
        } else {
            url += '&scope=' + encodeURIComponent(temp);
        }
    }
    if (integration === 'gmail' || integration === 'google_sheets' || integration === 'google_calendar' || integration === 'google_analytics') { //this is need for google products to get refresh tokens
        url += '&access_type=offline';
        url += '&approval_prompt=force';
    }
    url += '&state=' + encodeURIComponent(state);
    return url;
};

let access = (code, id, secret, redirect_url, state2, integration, accountName) => {
    let tokenUrl = webUrl[integration].token;
    if (state == state2) {
        let options = {
            method: 'POST',
            url: tokenUrl,
            headers:
                {
                    'Cache-Control': 'no-cache',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
            form:
                {
                    code: code,
                    client_id: id,
                    client_secret: secret,
                    redirect_uri: redirect_url,
                    grant_type: "authorization_code",
                }
        };
        request(options, async (error, response, body) => {
            if (error) throw new Error(error);
            let data = JSON.parse(body);
            if (data.error) {
                logger.errorLog.error("Error in post request in webAuth " + data.error);
                return data.error;
            } else {
                await insertIntoDB(data, accountName, integration, id, secret);
            }
        });
    }
};

let insertIntoDB = async (data, accountName, integration, client_id, client_secret) => {
    let date = null;
    if (data.expires_in != undefined) {
        date = expiryDate(data.expires_in);
    }
    let database = new setup.database(config);
    try {
        const CREATE_TABLE = "CREATE TABLE IF NOT EXISTS AccessKeys(AccountName varchar(150) NOT NULL PRIMARY KEY, IntegrationName varchar(255), AccessToken varchar(1024), RefreshToken varchar(1024), ClientId varchar(1024), ClientSecret varchar(1024), Expiry int(11), ExpiryDate datetime, Active tinyint(1))";
        await database.query(CREATE_TABLE).catch(err => {
            logger.errorLog.error("Error creating table AccessKey " + err);
        }).then(() => {
            const SQL = 'INSERT INTO AccessKeys (AccountName, IntegrationName, AccessToken, RefreshToken, Expiry, ExpiryDate , ClientId, ClientSecret, Active) VALUES (?,?,?,?,?,?,?,?,?)ON DUPLICATE KEY UPDATE IntegrationName = VALUES(IntegrationName), AccessToken = VALUES(AccessToken), RefreshToken =VALUES(RefreshToken), Expiry = VALUES(Expiry), ExpiryDate = VALUES(ExpiryDate), ClientId = VALUES(ClientId) , ClientSecret = VALUES(ClientSecret);';
            let values = [accountName, integration, data.access_token, data.refresh_token, data.expires_in, date, client_id, client_secret,1];
            database.query(SQL, values).catch(err => {
                logger.errorLog.error("Error inserting into AccessKeys for " + accountName + " " + err);
            });
        });
    } finally {
        try {
            await database.close();
        } catch (e) {
            logger.errorLog.error("Error closing database in access() in webAuth.js " + e);
        }
    }
};


let expiryDate = (seconds) => {
    let date = new Date();
    let hours = Math.floor(seconds / 3600);
    if (hours < 24) {
        date.setHours(date.getHours() + hours);
    } else {
        let days = Math.floor(hours / 24);
        date.setDate(date.getDate() + days)
    }
    return date.toISOString();
};


module.exports = new datafire.Action({
    inputs: [{
        type: "string",
        title: "client_id",
        default: "",
    }, {
        type: "string",
        title: "client_secret",
        default: "",
    }, {
        type: "string",
        title: "integration",
    }, {
        type: "string",
        title: "client_id",
    }, {
        type: "string",
        title: "accountName"
    }, {
        type: "string",
        title: "shop",
        default: "",
    }],

    handler: async (input) => {
        const redirect_url = 'http://localhost:3333'; // use context obj to get url path to replace localhost
        shop = input.shop;
        integration = input.integration;
        clientId = input.client_id;
        clientSecret = input.client_secret;
        accountName = input.accountName;
        logger.accessLog.verbose("Web Oauth integration for: " + integration + " for " + accountName);
        let code = null;
        let state2 = null;
        let url = null;
        let shopifyObj = null;
        if (input.integration === "shopify") {
            let tempObj = getShopifyURL(shop, clientId, clientSecret);
            shopifyObj = tempObj.shopify;
            url = tempObj.url;
        } else {
            url = getOAuthURL(clientId, redirect_url, integration);
        }
        app.get('/', (req, res) => {
            if (integration === "shopify") {
                shopifyObj.exchange_temporary_token(req.query, async function (err, data) {
                    await insertIntoDB(data, accountName, integration, clientId, clientSecret);
                });
            } else {
                code = decodeURIComponent(req.query.code);
                state2 = decodeURIComponent(req.query.state);
                access(code, clientId, clientSecret, redirect_url, state2, integration, accountName);
            }
            res.send("Done!"); // equivalent to res.write + res.end
        });
        return {
            "authUrl": url,
        };
    },
});

