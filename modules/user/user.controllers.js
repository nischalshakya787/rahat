const mongoose = require('mongoose');
const RSUser = require('rs-user');
const ethers = require('ethers');

const { ObjectId } = mongoose.Schema;

const ws = require('../../helpers/utils/socket');
const { DataUtils } = require('../../helpers/utils');
const { Role } = require('./role.controllers');

const User = new RSUser.User({
  mongoose,
  controllers: {
    role: Role,
  },
  schema: {
    agency: { type: ObjectId, required: true, ref: 'Agency' },
    wallet_address: { type: String, required: true, unique: true },
  },
});

const controllers = {
  User,
  async loginWallet(req) {
    const { payload } = req;
    const { id, signature } = payload;
    const client = ws.getClient(id);
    if (!client) throw Error('WebSocket client does not exist.');

    const publicKey = ethers.utils.recoverAddress(ethers.utils.hashMessage(client.token), signature);
    const user = await controllers.getByWalletAddress(publicKey);

    if (user && !user.is_active) {
      ws.sendToClient(id, { action: 'account-locked' });
      return 'Your account is locked, please contact administrator.';
    }

    if (!user) {
      ws.sendToClient(id, { action: 'unauthorized', publicKey });
      return 'You are unathorized to use this service';
    }

    const accessToken = await User.generateToken(user);
    const authData = { action: 'access-granted', accessToken };
    if (payload.encryptedWallet) authData.encryptedWallet = payload.encryptedWallet;
    ws.sendToClient(id, authData);
    return 'You have successfully logged on to Rahat Systems.';
  },

  setWalletAddress(userId, walletAddress) {
    return User.update(userId, {
      wallet_address: walletAddress,
    });
  },

  getByWalletAddress(walletAddress) {
    return User.model.findOne({ wallet_address: walletAddress });
  },

  findById(request) {
    const isObjectId = mongoose.Types.ObjectId;

    if (isObjectId.isValid(request.params.id)) {
      return User.getById(request.params.id);
    }
    return controllers.getByWalletAddress(request.params.id);
  },

  async addRoles(request) {
    const userId = request.params.id;
    const { roles } = request.payload;
    const isValid = await Role.isValidRole(roles);
    if (!isValid) throw Error('role does not exist');
    return User.addRoles({ user_id: userId, roles });
  },

  async update(request) {
    const userId = request.params.id;
    await controllers.checkUser(request);
    return User.update(userId, request.payload);
  },

  list(request) {
    let {
      start, limit, sort, filter, name, paging = true,
    } = request.query;
    const query = [];
    const $match = {};
    if (filter) query.push({ $match: filter });
    if (name) {
      query.push({
        $match: {
          'name.first': { $regex: new RegExp(`${name}`), $options: 'i' },
        },
      });
    }

    query.push(
      {
        $addFields: { full_name: { $concat: ['$name.first', ' ', '$name.last'] } },
      },
      {
        $unset: ['password'],
      },
    );
    sort = sort || { 'name.first': 1 };

    if (paging) {
      return DataUtils.paging({
        start,
        limit,
        sort,
        model: User.model,
        query,
      });
    }

    query.push({ $sort: sort });
    return User.model.aggregate(query);
  },

  async checkUser(request) {
    const data = request.payload;
    if (!data.wallet_address) data.wallet_address = '';
    if (!data.phone) data.phone = '';
    if (!data.email) data.email = '';
    data.wallet_address = data.wallet_address.toLowerCase();
    const [user] = await User.model.find({
      $or: [{ wallet_address: data.wallet_address }, { email: data.email }, { phone: data.phone }],
    });
    if (user) {
      if (user.phone === data.phone) throw new Error('Phone Number Already Exists');
      if (user.wallet_address.toLowerCase() === data.wallet_address.toLowerCase()) {
        throw Error('Wallet Address Already Exists');
      }
      if (user.email === data.email) throw Error('Email Already Exists');
      return false;
    }
    return { isNew: true };
  },

  async add(request) {
    const data = request.payload;
    try {
      await controllers.checkUser(request);
      data.wallet_address = data.wallet_address.toLowerCase();
      const user = await User.create(data);
      return user;
    } catch (e) {
      return e;
    }
  },

  async auth(request) {
    try {
      const token = request.query.access_token || request.headers.access_token || request.cookies.access_token;
      const { user, permissions } = await User.validateToken(token);

      return {
        user,
        permissions,
      };
    } catch (e) {
      throw Error(`ERROR: ${e}`);
    }
  },
};

module.exports = controllers;
