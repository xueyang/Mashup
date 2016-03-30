/**
 * Copyright 2013, 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
RED.editor = (function() {
    var editing_node = null;
    var editing_config_node = null;
    var subflowEditor;

    function getCredentialsURL(nodeType, nodeID) {
        var dashedType = nodeType.replace(/\s+/g, '-');
        return  'credentials/' + dashedType + "/" + nodeID;
    }

    /**
     * Validate a node
     * @param node - the node being validated
     * @returns {boolean} whether the node is valid. Sets node.dirty if needed
     */
    function validateNode(node) {
        var oldValue = node.valid;
        var oldChanged = node.changed;
        node.valid = true;
        var subflow;
        var isValid;
        var hasChanged;
        if (node.type.indexOf("subflow:")===0) {
            subflow = RED.nodes.subflow(node.type.substring(8));
            isValid = subflow.valid;
            hasChanged = subflow.changed;
            if (isValid === undefined) {
                isValid = validateNode(subflow);
                hasChanged = subflow.changed;
            }
            node.valid = isValid;
            node.changed = node.changed || hasChanged;
        } else if (node._def) {
            node.valid = validateNodeProperties(node, node._def.defaults, node);
            if (node._def._creds) {
                node.valid = node.valid && validateNodeProperties(node, node._def.credentials, node._def._creds);
            }
        } else if (node.type == "subflow") {
            var subflowNodes = RED.nodes.filterNodes({z:node.id});
            for (var i=0;i<subflowNodes.length;i++) {
                isValid = subflowNodes[i].valid;
                hasChanged = subflowNodes[i].changed;
                if (isValid === undefined) {
                    isValid = validateNode(subflowNodes[i]);
                    hasChanged = subflowNodes[i].changed;
                }
                node.valid = node.valid && isValid;
                node.changed = node.changed || hasChanged;
            }
            var subflowInstances = RED.nodes.filterNodes({type:"subflow:"+node.id});
            var modifiedTabs = {};
            for (i=0;i<subflowInstances.length;i++) {
                subflowInstances[i].valid = node.valid;
                subflowInstances[i].changed = subflowInstances[i].changed || node.changed;
                subflowInstances[i].dirty = true;
                modifiedTabs[subflowInstances[i].z] = true;
            }
            Object.keys(modifiedTabs).forEach(function(id) {
                var subflow = RED.nodes.subflow(id);
                if (subflow) {
                    validateNode(subflow);
                }
            });
        }
        if (oldValue !== node.valid || oldChanged !== node.changed) {
            node.dirty = true;
            subflow = RED.nodes.subflow(node.z);
            if (subflow) {
                validateNode(subflow);
            }
        }
        return node.valid;
    }

    /**
     * Validate a node's properties for the given set of property definitions
     * @param node - the node being validated
     * @param definition - the node property definitions (either def.defaults or def.creds)
     * @param properties - the node property values to validate
     * @returns {boolean} whether the node's properties are valid
     */
    function validateNodeProperties(node, definition, properties) {
        var isValid = true;
        for (var prop in definition) {
            if (definition.hasOwnProperty(prop)) {
                if (!validateNodeProperty(node, definition, prop, properties[prop])) {
                    isValid = false;
                }
            }
        }
        return isValid;
    }

    /**
     * Validate a individual node property
     * @param node - the node being validated
     * @param definition - the node property definitions (either def.defaults or def.creds)
     * @param property - the property name being validated
     * @param value - the property value being validated
     * @returns {boolean} whether the node proprty is valid
     */
    function validateNodeProperty(node,definition,property,value) {
        var valid = true;
        if ("required" in definition[property] && definition[property].required) {
            valid = value !== "";
        }
        if (valid && "validate" in definition[property]) {
            valid = definition[property].validate.call(node,value);
        }
        if (valid && definition[property].type && RED.nodes.getType(definition[property].type) && !("validate" in definition[property])) {
            if (!value || value == "_ADD_") {
                valid = definition[property].hasOwnProperty("required") && !definition[property].required;
            } else {
                var v = RED.nodes.node(value).valid;
                valid = (v==null || v);
            }
        }
        return valid;
    }

    /**
     * Called when the node's properties have changed.
     * Marks the node as dirty and needing a size check.
     * Removes any links to non-existant outputs.
     * @param node - the node that has been updated
     * @returns {array} the links that were removed due to this update
     */
    function updateNodeProperties(node) {
        node.resize = true;
        node.dirty = true;
        var removedLinks = [];
        if (node.ports) {
            if (node.outputs < node.ports.length) {
                while (node.outputs < node.ports.length) {
                    node.ports.pop();
                }
                RED.nodes.eachLink(function(l) {
                        if (l.source === node && l.sourcePort >= node.outputs) {
                            removedLinks.push(l);
                        }
                });
            } else if (node.outputs > node.ports.length) {
                while (node.outputs > node.ports.length) {
                    node.ports.push(node.ports.length);
                }
            }
        }
        if (node.inputs === 0) {
            removedLinks.concat(RED.nodes.filterLinks({target:node}));
        }
        for (var l=0;l<removedLinks.length;l++) {
            RED.nodes.removeLink(removedLinks[l]);
        }
        return removedLinks;
    }

    function createDialog(){
        $( "#dialog" ).dialog({
                modal: true,
                autoOpen: false,
                dialogClass: "ui-dialog-no-close",
                closeOnEscape: false,
                minWidth: 500,
                width: 'auto',
                buttons: [
                    {
                        id: "node-dialog-ok",
                        text: RED._("common.label.ok"),
                        click: function() {
                            if (editing_node) {
                                var changes = {};
                                var changed = false;
                                var wasDirty = RED.nodes.dirty();
                                var d;

                                if (editing_node._def.oneditsave) {
                                    var oldValues = {};
                                    for (d in editing_node._def.defaults) {
                                        if (editing_node._def.defaults.hasOwnProperty(d)) {
                                            if (typeof editing_node[d] === "string" || typeof editing_node[d] === "number") {
                                                oldValues[d] = editing_node[d];
                                            } else {
                                                oldValues[d] = $.extend(true,{},{v:editing_node[d]}).v;
                                            }
                                        }
                                    }
                                    var rc = editing_node._def.oneditsave.call(editing_node);
                                    if (rc === true) {
                                        changed = true;
                                    }

                                    for (d in editing_node._def.defaults) {
                                        if (editing_node._def.defaults.hasOwnProperty(d)) {
                                            if (oldValues[d] === null || typeof oldValues[d] === "string" || typeof oldValues[d] === "number") {
                                                if (oldValues[d] !== editing_node[d]) {
                                                    changes[d] = oldValues[d];
                                                    changed = true;
                                                }
                                            } else {
                                                if (JSON.stringify(oldValues[d]) !== JSON.stringify(editing_node[d])) {
                                                    changes[d] = oldValues[d];
                                                    changed = true;
                                                }
                                            }
                                        }
                                    }
                                }

                                if (editing_node._def.defaults) {
                                    for (d in editing_node._def.defaults) {
                                        if (editing_node._def.defaults.hasOwnProperty(d)) {
                                            var input = $("#node-input-"+d);
                                            var newValue;
                                            if (input.attr('type') === "checkbox") {
                                                newValue = input.prop('checked');
                                            } else {
                                                newValue = input.val();
                                            }
                                            if (newValue != null) {
                                                if (d === "outputs" && (newValue.trim() === "" || isNaN(newValue))) {
                                                    continue;
                                                }
                                                if (editing_node[d] != newValue) {
                                                    if (editing_node._def.defaults[d].type) {
                                                        if (newValue == "_ADD_") {
                                                            newValue = "";
                                                        }
                                                        // Change to a related config node
                                                        var configNode = RED.nodes.node(editing_node[d]);
                                                        if (configNode) {
                                                            var users = configNode.users;
                                                            users.splice(users.indexOf(editing_node),1);
                                                        }
                                                        configNode = RED.nodes.node(newValue);
                                                        if (configNode) {
                                                            configNode.users.push(editing_node);
                                                        }
                                                    }
                                                    changes[d] = editing_node[d];
                                                    editing_node[d] = newValue;
                                                    changed = true;
                                                }
                                            }
                                        }
                                    }
                                }
                                if (editing_node._def.credentials) {
                                    var prefix = 'node-input';
                                    var credDefinition = editing_node._def.credentials;
                                    var credsChanged = updateNodeCredentials(editing_node,credDefinition,prefix);
                                    changed = changed || credsChanged;
                                }

                                var removedLinks = updateNodeProperties(editing_node);
                                if (changed) {
                                    var wasChanged = editing_node.changed;
                                    editing_node.changed = true;
                                    RED.nodes.dirty(true);

                                    var activeSubflow = RED.nodes.subflow(RED.workspaces.active());
                                    var subflowInstances = null;
                                    if (activeSubflow) {
                                        subflowInstances = [];
                                        RED.nodes.eachNode(function(n) {
                                            if (n.type == "subflow:"+RED.workspaces.active()) {
                                                subflowInstances.push({
                                                    id:n.id,
                                                    changed:n.changed
                                                });
                                                n.changed = true;
                                                n.dirty = true;
                                                updateNodeProperties(n);
                                            }
                                        });
                                    }
                                    var historyEvent = {
                                        t:'edit',
                                        node:editing_node,
                                        changes:changes,
                                        links:removedLinks,
                                        dirty:wasDirty,
                                        changed:wasChanged
                                    };
                                    if (subflowInstances) {
                                        historyEvent.subflow = {
                                            instances:subflowInstances
                                        }
                                    }
                                    RED.history.push(historyEvent);
                                }
                                editing_node.dirty = true;
                                validateNode(editing_node);
                                RED.view.redraw();
                            } else if (/Export nodes to library/.test($( "#dialog" ).dialog("option","title"))) {
                                //TODO: move this to RED.library
                                var flowName = $("#node-input-filename").val();
                                if (!/^\s*$/.test(flowName)) {
                                    $.ajax({
                                        url:'library/flows/'+flowName,
                                        type: "POST",
                                        data: $("#node-input-filename").attr('nodes'),
                                        contentType: "application/json; charset=utf-8"
                                    }).done(function() {
                                            RED.library.loadFlowLibrary();
                                            RED.notify(RED._("library.savedNodes"),"success");
                                    }).fail(function(xhr,textStatus,err) {
                                        RED.notify(RED._("library.saveFailed",{message:xhr.responseText}),"error");
                                    });
                                }
                            }
                            $( this ).dialog( "close" );
                        }
                    },
                    {
                        id: "node-dialog-cancel",
                        text: RED._("common.label.cancel"),
                        click: function() {
                            if (editing_node && editing_node._def) {
                                if (editing_node._def.oneditcancel) {
                                    editing_node._def.oneditcancel.call(editing_node);
                                }

                                for (var d in editing_node._def.defaults) {
                                    if (editing_node._def.defaults.hasOwnProperty(d)) {
                                        var def = editing_node._def.defaults[d];
                                        if (def.type) {
                                            var configTypeDef = RED.nodes.getType(def.type);
                                            if (configTypeDef && configTypeDef.exclusive) {
                                                var input = $("#node-input-"+d).val()||"";
                                                if (input !== "" && !editing_node[d]) {
                                                    // This node has an exclusive config node that
                                                    // has just been added. As the user is cancelling
                                                    // the edit, need to delete the just-added config
                                                    // node so that it doesn't get orphaned.
                                                    RED.nodes.remove(input);
                                                }
                                            }
                                        }
                                    }

                                }


                            }
                            $( this ).dialog( "close" );
                        }
                    }
                ],
                resize: function(e,ui) {
                    if (editing_node) {
                        $(this).dialog('option',"sizeCache-"+editing_node.type,ui.size);
                    }
                },
                open: function(e) {
                    var minWidth = $(this).dialog('option','minWidth');
                    if ($(this).outerWidth() < minWidth) {
                        $(this).dialog('option','width',minWidth);
                    } else {
                        $(this).dialog('option','width',$(this).outerWidth());
                    }
                    RED.keyboard.disable();
                    if (editing_node) {
                        var size = $(this).dialog('option','sizeCache-'+editing_node.type);
                        if (size) {
                            $(this).dialog('option','width',size.width);
                            $(this).dialog('option','height',size.height);
                        }
                    }
                },
                close: function(e) {
                    RED.keyboard.enable();

                    if (RED.view.state() != RED.state.IMPORT_DRAGGING) {
                        RED.view.state(RED.state.DEFAULT);
                    }
                    $( this ).dialog('option','height','auto');
                    $( this ).dialog('option','width','auto');
                    if (editing_node) {
                        RED.sidebar.info.refresh(editing_node);
                    }
                    RED.workspaces.refresh();

                    var buttons = $( this ).dialog("option","buttons");
                    if (buttons.length == 3) {
                        $( this ).dialog("option","buttons",buttons.splice(1));
                    }
                    editing_node = null;
                }
        });
    }

    /**
     * Create a config-node select box for this property
     * @param node - the node being edited
     * @param property - the name of the field
     * @param type - the type of the config-node
     */
    function prepareConfigNodeSelect(node,property,type) {
        var input = $("#node-input-"+property);
        var node_def = RED.nodes.getType(type);

        input.replaceWith('<select style="width: 60%;" id="node-input-'+property+'"></select>');
        updateConfigNodeSelect(property,type,node[property]);
        var select = $("#node-input-"+property);
        select.after(' <a id="node-input-lookup-'+property+'" class="editor-button"><i class="fa fa-pencil"></i></a>');
        $('#node-input-lookup-'+property).click(function(e) {
            showEditConfigNodeDialog(property,type,select.find(":selected").val());
            e.preventDefault();
        });
        var label = "";
        var configNode = RED.nodes.node(node[property]);
        if (configNode && node_def.label) {
            if (typeof node_def.label == "function") {
                label = node_def.label.call(configNode);
            } else {
                label = node_def.label;
            }
        }
        input.val(label);
    }

    /**
     * Create a config-node button for this property
     * @param node - the node being edited
     * @param property - the name of the field
     * @param type - the type of the config-node
     */
    function prepareConfigNodeButton(node,property,type) {
        var input = $("#node-input-"+property);
        input.val(node[property]);
        input.attr("type","hidden");

        var button = $("<a>",{id:"node-input-edit-"+property, class:"editor-button"});
        input.after(button);

        if (node[property]) {
            button.text(RED._("editor.configEdit"));
        } else {
            button.text(RED._("editor.configAdd"));
        }

        button.click(function(e) {
            showEditConfigNodeDialog(property,type,input.val()||"_ADD_");
            e.preventDefault();
        });
    }

    /**
     * Populate the editor dialog input field for this property
     * @param node - the node being edited
     * @param property - the name of the field
     * @param prefix - the prefix to use in the input element ids (node-input|node-config-input)
     */
    function preparePropertyEditor(node,property,prefix) {
        var input = $("#"+prefix+"-"+property);
        if (input.attr('type') === "checkbox") {
            input.prop('checked',node[property]);
        } else {
            var val = node[property];
            if (val == null) {
                val = "";
            }
            input.val(val);
        }
    }

    /**
     * Add an on-change handler to revalidate a node field
     * @param node - the node being edited
     * @param definition - the definition of the node
     * @param property - the name of the field
     * @param prefix - the prefix to use in the input element ids (node-input|node-config-input)
     */
    function attachPropertyChangeHandler(node,definition,property,prefix) {
        $("#"+prefix+"-"+property).change(function() {
            if (!validateNodeProperty(node, definition, property,this.value)) {
                $(this).addClass("input-error");
            } else {
                $(this).removeClass("input-error");
            }
        });
    }

    /**
     * Assign the value to each credential field
     * @param node
     * @param credDef
     * @param credData
     * @param prefix
     */
    function populateCredentialsInputs(node, credDef, credData, prefix) {
        var cred;
        for (cred in credDef) {
            if (credDef.hasOwnProperty(cred)) {
                if (credDef[cred].type == 'password') {
                    if (credData[cred]) {
                        $('#' + prefix + '-' + cred).val(credData[cred]);
                    } else if (credData['has_' + cred]) {
                        $('#' + prefix + '-' + cred).val('__PWRD__');
                    }
                    else {
                        $('#' + prefix + '-' + cred).val('');
                    }
                } else {
                    preparePropertyEditor(credData, cred, prefix);
                }
                attachPropertyChangeHandler(node, credDef, cred, prefix);
            }
        }
        for (cred in credDef) {
            if (credDef.hasOwnProperty(cred)) {
                $("#" + prefix + "-" + cred).change();
            }
        }
    }

    /**
     * Update the node credentials from the edit form
     * @param node - the node containing the credentials
     * @param credDefinition - definition of the credentials
     * @param prefix - prefix of the input fields
     * @return {boolean} whether anything has changed
     */
    function updateNodeCredentials(node, credDefinition, prefix) {
        var changed = false;
        if(!node.credentials) {
            node.credentials = {_:{}};
        }

        for (var cred in credDefinition) {
            if (credDefinition.hasOwnProperty(cred)) {
                var input = $("#" + prefix + '-' + cred);
                var value = input.val();
                if (credDefinition[cred].type == 'password') {
                    node.credentials['has_' + cred] = (value !== "");
                    if (value == '__PWRD__') {
                        continue;
                    }
                    changed = true;

                }
                node.credentials[cred] = value;
                if (value != node.credentials._[cred]) {
                    changed = true;
                }
            }
        }
        return changed;
    }

    /**
     * Prepare all of the editor dialog fields
     * @param node - the node being edited
     * @param definition - the node definition
     * @param prefix - the prefix to use in the input element ids (node-input|node-config-input)
     */
    function prepareEditDialog(node,definition,prefix) {
        for (var d in definition.defaults) {
            if (definition.defaults.hasOwnProperty(d)) {
                if (definition.defaults[d].type) {
                    var configTypeDef = RED.nodes.getType(definition.defaults[d].type);
                    if (configTypeDef) {
                        if (configTypeDef.exclusive) {
                            prepareConfigNodeButton(node,d,definition.defaults[d].type);
                        } else {
                            prepareConfigNodeSelect(node,d,definition.defaults[d].type);
                        }
                    } else {
                        console.log("Unknown type:", definition.defaults[d].type);
                        preparePropertyEditor(node,d,prefix);
                    }
                } else {
                    preparePropertyEditor(node,d,prefix);
                }
                attachPropertyChangeHandler(node,definition.defaults,d,prefix);
            }
        }
        var completePrepare = function() {
            if (definition.oneditprepare) {
                definition.oneditprepare.call(node);
            }
            for (var d in definition.defaults) {
                if (definition.defaults.hasOwnProperty(d)) {
                    $("#"+prefix+"-"+d).change();
                }
            }
        }

        if (definition.credentials) {
            if (node.credentials) {
                populateCredentialsInputs(node, definition.credentials, node.credentials, prefix);
                completePrepare();
            } else {
                $.getJSON(getCredentialsURL(node.type, node.id), function (data) {
                    node.credentials = data;
                    node.credentials._ = $.extend(true,{},data);
                    populateCredentialsInputs(node, definition.credentials, node.credentials, prefix);
                    completePrepare();
                });
            }
        } else {
            completePrepare();
        }
    }

    function showEditDialog(node) {
        editing_node = node;
        RED.view.state(RED.state.EDITING);
        var type = node.type;
        if (node.type.substring(0,8) == "subflow:") {
            type = "subflow";
            var id = editing_node.type.substring(8);
            var buttons = $( "#dialog" ).dialog("option","buttons");
            buttons.unshift({
                class: 'leftButton',
                text: RED._("subflow.edit"),
                click: function() {
                    RED.workspaces.show(id);
                    $("#node-dialog-ok").click();
                }
            });
            $( "#dialog" ).dialog("option","buttons",buttons);
        }
        $("#dialog-form").html($("script[data-template-name='"+type+"']").html());
        var ns;
        if (node._def.set.module === "node-red") {
            ns = "node-red";
        } else {
            ns = node._def.set.id;
        }
        $("#dialog-form").find('[data-i18n]').each(function() {
            var current = $(this).attr("data-i18n");
            var keys = current.split(";");
            for (var i=0;i<keys.length;i++) {
                var key = keys[i];
                if (key.indexOf(":") === -1) {
                    var prefix = "";
                    if (key.indexOf("[")===0) {
                        var parts = key.split("]");
                        prefix = parts[0]+"]";
                        key = parts[1];
                    }
                    keys[i] = prefix+ns+":"+key;
                }
            }
            $(this).attr("data-i18n",keys.join(";"));
        });
        $('<input type="text" style="display: none;" />').appendTo("#dialog-form");
        prepareEditDialog(node,node._def,"node-input");
        $("#dialog").i18n();
        $( "#dialog" ).dialog("option","title","Edit "+type+" node").dialog( "open" );
    }

    function showEditConfigNodeDialog(name,type,id) {
        var adding = (id == "_ADD_");
        var node_def = RED.nodes.getType(type);
        editing_config_node = RED.nodes.node(id);

        var ns;
        if (node_def.set.module === "node-red") {
            ns = "node-red";
        } else {
            ns = node_def.set.id;
        }

        var activeWorkspace = RED.nodes.workspace(RED.workspaces.active());
        if (!activeWorkspace) {
            activeWorkspace = RED.nodes.subflow(RED.workspaces.active());
        }

        if (editing_config_node == null) {
            editing_config_node = {
                id: (1+Math.random()*4294967295).toString(16),
                _def: node_def,
                type: type,
                z: activeWorkspace.id,
                users: []
            }
            for (var d in node_def.defaults) {
                if (node_def.defaults[d].value) {
                    editing_config_node[d] = node_def.defaults[d].value;
                }
            }
            editing_config_node["_"] = node_def._;
        }

        $("#node-config-dialog-edit-form").html($("script[data-template-name='"+type+"']").html());

        $("#dialog-config-form").find('[data-i18n]').each(function() {
            var current = $(this).attr("data-i18n");
            if (current.indexOf(":") === -1) {
                var prefix = "";
                if (current.indexOf("[")===0) {
                    var parts = current.split("]");
                    prefix = parts[0]+"]";
                    current = parts[1];
                }
                $(this).attr("data-i18n",prefix+ns+":"+current);
            }
        });


        prepareEditDialog(editing_config_node,node_def,"node-config-input");

        var buttons = $( "#node-config-dialog" ).dialog("option","buttons");
        if (adding) {
            if (buttons.length == 3) {
                buttons = buttons.splice(1);
            }
            buttons[0].text = "Add";
            $("#node-config-dialog-user-count").find("span").html("").parent().hide();
        } else {
            if (buttons.length == 2) {
                buttons.unshift({
                        class: 'leftButton',
                        text: RED._("editor.configDelete"),
                        click: function() {
                            var configProperty = $(this).dialog('option','node-property');
                            var configId = $(this).dialog('option','node-id');
                            var configType = $(this).dialog('option','node-type');

                            var configTypeDef = RED.nodes.getType(configType);

                            if (configTypeDef.ondelete) {
                                configTypeDef.ondelete.call(editing_config_node);
                            }
                            if (configTypeDef.oneditdelete) {
                                configTypeDef.oneditdelete.call(editing_config_node);
                            }
                            var historyEvent = {
                                t:'delete',
                                nodes:[editing_config_node],
                                changes: {},
                                dirty: RED.nodes.dirty()
                            }
                            RED.nodes.remove(configId);
                            for (var i=0;i<editing_config_node.users.length;i++) {
                                var user = editing_config_node.users[i];
                                historyEvent.changes[user.id] = {
                                    changed: user.changed,
                                    valid: user.valid
                                };
                                for (var d in user._def.defaults) {
                                    if (user._def.defaults.hasOwnProperty(d) && user[d] == configId) {
                                        historyEvent.changes[user.id][d] = configId
                                        user[d] = "";
                                        user.changed = true;
                                        user.dirty = true;
                                    }
                                }
                                validateNode(user);
                            }
                            updateConfigNodeSelect(configProperty,configType,"");
                            RED.nodes.dirty(true);
                            $( this ).dialog( "close" );
                            RED.view.redraw();
                            RED.history.push(historyEvent);
                        }
                });
            }
            buttons[1].text = "Update";
            $("#node-config-dialog-user-count").find("span").html(RED._("editor.nodesUse", {count:editing_config_node.users.length})).parent().show();
        }

        if (editing_config_node._def.exclusive) {
            $("#node-config-dialog-scope").hide();
        } else {
            $("#node-config-dialog-scope").show();
        }
        $("#node-config-dialog-scope-warning").hide();


        var nodeUserFlows = {};
        editing_config_node.users.forEach(function(n) {
            nodeUserFlows[n.z] = true;
        });
        var flowCount = Object.keys(nodeUserFlows).length;

        var tabSelect = $("#node-config-dialog-scope").empty();
        tabSelect.off("change");
        tabSelect.append('<option value=""'+(!editing_config_node.z?" selected":"")+' data-i18n="sidebar.config.global"></option>');
        tabSelect.append('<option disabled data-i18n="sidebar.config.flows"></option>');
        RED.nodes.eachWorkspace(function(ws) {
            var workspaceLabel = ws.label;
            if (nodeUserFlows[ws.id]) {
                workspaceLabel = "* "+workspaceLabel;
            }
            tabSelect.append('<option value="'+ws.id+'"'+(ws.id==editing_config_node.z?" selected":"")+'>'+workspaceLabel+'</option>');
        });
        tabSelect.append('<option disabled data-i18n="sidebar.config.subflows"></option>');
        RED.nodes.eachSubflow(function(ws) {
            var workspaceLabel = ws.name;
            if (nodeUserFlows[ws.id]) {
                workspaceLabel = "* "+workspaceLabel;
            }
            tabSelect.append('<option value="'+ws.id+'"'+(ws.id==editing_config_node.z?" selected":"")+'>'+workspaceLabel+'</option>');
        });
        if (flowCount > 0) {
            tabSelect.on('change',function() {
                var newScope = $(this).val();
                if (newScope === '') {
                    // global scope - everyone can use it
                    $("#node-config-dialog-scope-warning").hide();
                } else if (!nodeUserFlows[newScope] || flowCount > 1) {
                    // a user will loose access to it
                    $("#node-config-dialog-scope-warning").show();
                } else {
                    $("#node-config-dialog-scope-warning").hide();
                }
            });
        }

        //tabSelect.append('<option value="'+activeWorkspace.id+'"'+(activeWorkspace.id==configNode.z?" selected":"")+'>'+workspaceLabel+'</option>');
        tabSelect.i18n();

        $( "#node-config-dialog" ).dialog("option","buttons",buttons);

        $("#node-config-dialog").i18n();

        $( "#node-config-dialog" )
            .dialog("option","node-adding",adding)
            .dialog("option","node-property",name)
            .dialog("option","node-id",editing_config_node.id)
            .dialog("option","node-type",type)
            .dialog("option","title",(adding?RED._("editor.addNewConfig", {type:type}):RED._("editor.editConfig", {type:type})))
            .dialog( "open" );
    }

    function updateConfigNodeSelect(name,type,value) {
        var button = $("#node-input-edit-"+name);
        if (button.length) {
            if (value) {
                button.text(RED._("editor.configEdit"));
            } else {
                button.text(RED._("editor.configAdd"));
            }
            $("#node-input-"+name).val(value);
        } else {

            var select = $("#node-input-"+name);
            var node_def = RED.nodes.getType(type);
            select.children().remove();

            var activeWorkspace = RED.nodes.workspace(RED.workspaces.active());
            if (!activeWorkspace) {
                activeWorkspace = RED.nodes.subflow(RED.workspaces.active());
            }

            var configNodes = [];

            RED.nodes.eachConfig(function(config) {
                if (config.type == type && (!config.z || config.z === activeWorkspace.id)) {
                    var label = "";
                    if (typeof node_def.label == "function") {
                        label = node_def.label.call(config);
                    } else {
                        label = node_def.label;
                    }
                    configNodes.push({id:config.id,label:label});
                }
            });

            configNodes.sort(function(A,B) {
                if (A.label < B.label) {
                    return -1;
                } else if (A.label > B.label) {
                    return 1;
                }
                return 0;
            });

            configNodes.forEach(function(cn) {
                select.append('<option value="'+cn.id+'"'+(value==cn.id?" selected":"")+'>'+cn.label+'</option>');
            });

            select.append('<option value="_ADD_"'+(value===""?" selected":"")+'>'+RED._("editor.addNewType", {type:type})+'</option>');
            window.setTimeout(function() { select.change();},50);
        }
    }

    function createNodeConfigDialog(){
        $( "#node-config-dialog" ).dialog({
                modal: true,
                autoOpen: false,
                dialogClass: "ui-dialog-no-close",
                minWidth: 500,
                width: 'auto',
                closeOnEscape: false,
                buttons: [
                    {
                        id: "node-config-dialog-ok",
                        text: RED._("common.label.ok"),
                        click: function() {
                            var configProperty = $(this).dialog('option','node-property');
                            var configId = $(this).dialog('option','node-id');
                            var configType = $(this).dialog('option','node-type');
                            var configAdding = $(this).dialog('option','node-adding');
                            var configTypeDef = RED.nodes.getType(configType);
                            var d;
                            var input;
                            var scope = $("#node-config-dialog-scope").val();
                            for (d in configTypeDef.defaults) {
                                if (configTypeDef.defaults.hasOwnProperty(d)) {
                                    input = $("#node-config-input-"+d);
                                    if (input.attr('type') === "checkbox") {
                                      editing_config_node[d] = input.prop('checked');
                                    } else {
                                      editing_config_node[d] = input.val();
                                    }
                                }
                            }
                            editing_config_node.label = configTypeDef.label;
                            editing_config_node.z = scope;

                            if (scope) {
                                editing_config_node.users = editing_config_node.users.filter(function(n) {
                                    var keep = true;
                                    for (var d in n._def.defaults) {
                                        if (n._def.defaults.hasOwnProperty(d)) {
                                            if (n._def.defaults[d].type === editing_config_node.type &&
                                                n[d] === editing_config_node.id &&
                                                n.z !== scope) {
                                                    keep = false;
                                                    n[d] = null;
                                                    n.dirty = true;
                                                    n.changed = true;
                                                    validateNode(n);
                                            }
                                        }
                                    }
                                    return keep;
                                });
                            }

                            if (configAdding) {
                                RED.nodes.add(editing_config_node);
                            }

                            updateConfigNodeSelect(configProperty,configType,editing_config_node.id);

                            if (configTypeDef.credentials) {
                                updateNodeCredentials(editing_config_node,configTypeDef.credentials,"node-config-input");
                            }
                            if (configTypeDef.oneditsave) {
                                configTypeDef.oneditsave.call(editing_config_node);
                            }
                            validateNode(editing_config_node);
                            for (var i=0;i<editing_config_node.users.length;i++) {
                                var user = editing_config_node.users[i];
                                validateNode(user);
                            }

                            RED.nodes.dirty(true);
                            RED.view.redraw(true);
                            $(this).dialog("close");

                        }
                    },
                    {
                        id: "node-config-dialog-cancel",
                        text: RED._("common.label.cancel"),
                        click: function() {
                            var configType = $(this).dialog('option','node-type');
                            var configId = $(this).dialog('option','node-id');
                            var configAdding = $(this).dialog('option','node-adding');
                            var configTypeDef = RED.nodes.getType(configType);

                            if (configTypeDef.oneditcancel) {
                                // TODO: what to pass as this to call
                                if (configTypeDef.oneditcancel) {
                                    var cn = RED.nodes.node(configId);
                                    if (cn) {
                                        configTypeDef.oneditcancel.call(cn,false);
                                    } else {
                                        configTypeDef.oneditcancel.call({id:configId},true);
                                    }
                                }
                            }
                            $( this ).dialog( "close" );
                        }
                    }
                ],
                resize: function(e,ui) {
                },
                open: function(e) {
                    var minWidth = $(this).dialog('option','minWidth');
                    if ($(this).outerWidth() < minWidth) {
                        $(this).dialog('option','width',minWidth);
                    }
                    if (RED.view.state() != RED.state.EDITING) {
                        RED.keyboard.disable();
                    }
                },
                close: function(e) {
                    $(this).dialog('option','width','auto');
                    $(this).dialog('option','height','auto');
                    $("#node-config-dialog-edit-form").html("");
                    if (RED.view.state() != RED.state.EDITING) {
                        RED.keyboard.enable();
                    }
                    RED.workspaces.refresh();
                },
                create: function() {
                    $("#node-config-dialog").parent().find("div.ui-dialog-buttonpane")
                        .prepend('<div id="node-config-dialog-user-count"><i class="fa fa-info-circle"></i> <span></span></div>');

                    $("#node-config-dialog").parent().find('.ui-dialog-titlebar').append('<span id="node-config-dialog-scope-container"><span id="node-config-dialog-scope-warning" data-i18n="[title]editor.errors.scopeChange"><i class="fa fa-warning"></i></span><select id="node-config-dialog-scope"></select></span>');
                    $("#node-config-dialog").parent().draggable({
                        cancel: '.ui-dialog-content, .ui-dialog-titlebar-close, #node-config-dialog-scope-container'
                    });
                }
        });
    }

    function createSubflowDialog(){
        $( "#subflow-dialog" ).dialog({
            modal: true,
            autoOpen: false,
            dialogClass: "ui-dialog-no-close",
            closeOnEscape: false,
            minWidth: 500,
            width: 'auto',
            buttons: [
                {
                    id: "subflow-dialog-ok",
                    text: RED._("common.label.ok"),
                    click: function() {
                        if (editing_node) {
                            var i;
                            var changes = {};
                            var changed = false;
                            var wasDirty = RED.nodes.dirty();

                            var newName = $("#subflow-input-name").val();

                            if (newName != editing_node.name) {
                                changes['name'] = editing_node.name;
                                editing_node.name = newName;
                                changed = true;
                                $("#menu-item-workspace-menu-"+editing_node.id.replace(".","-")).text(newName);
                            }

                            var newDescription = subflowEditor.getValue();

                            if (newDescription != editing_node.info) {
                                changes['info'] = editing_node.info;
                                editing_node.info = newDescription;
                                changed = true;
                            }

                            RED.palette.refresh();

                            if (changed) {
                                var subflowInstances = [];
                                RED.nodes.eachNode(function(n) {
                                    if (n.type == "subflow:"+editing_node.id) {
                                        subflowInstances.push({
                                            id:n.id,
                                            changed:n.changed
                                        })
                                        n.changed = true;
                                        n.dirty = true;
                                        updateNodeProperties(n);
                                    }
                                });
                                var wasChanged = editing_node.changed;
                                editing_node.changed = true;
                                RED.nodes.dirty(true);
                                var historyEvent = {
                                    t:'edit',
                                    node:editing_node,
                                    changes:changes,
                                    dirty:wasDirty,
                                    changed:wasChanged,
                                    subflow: {
                                        instances:subflowInstances
                                    }
                                };

                                RED.history.push(historyEvent);
                            }
                            editing_node.dirty = true;
                            RED.view.redraw();
                        }
                        $( this ).dialog( "close" );
                    }
                },
                {
                    id: "subflow-dialog-cancel",
                    text: RED._("common.label.cancel"),
                    click: function() {
                        $( this ).dialog( "close" );
                        editing_node = null;
                    }
                }
            ],
            create: function(e) {
                $("#subflow-dialog form" ).submit(function(e) { e.preventDefault();});
                subflowEditor = RED.editor.createEditor({
                    id: 'subflow-input-info-editor',
                    mode: 'ace/mode/markdown',
                    value: ""
                });
            },
            open: function(e) {
                RED.keyboard.disable();
                var minWidth = $(this).dialog('option','minWidth');
                if ($(this).outerWidth() < minWidth) {
                    $(this).dialog('option','width',minWidth);
                }
            },
            close: function(e) {
                RED.keyboard.enable();

                if (RED.view.state() != RED.state.IMPORT_DRAGGING) {
                    RED.view.state(RED.state.DEFAULT);
                }
                RED.sidebar.info.refresh(editing_node);
                RED.workspaces.refresh();
                editing_node = null;
            },
            resize: function(e) {
                var rows = $("#subflow-dialog>form>div:not(.node-text-editor-row)");
                var editorRow = $("#subflow-dialog>form>div.node-text-editor-row");
                var height = $("#subflow-dialog").height();
                for (var i=0;i<rows.size();i++) {
                    height -= $(rows[i]).outerHeight(true);
                }
                height -= (parseInt($("#subflow-dialog>form").css("marginTop"))+parseInt($("#subflow-dialog>form").css("marginBottom")));
                $(".node-text-editor").css("height",height+"px");
                subflowEditor.resize();
            }
        });
    }


    function showEditSubflowDialog(subflow) {
        editing_node = subflow;
        RED.view.state(RED.state.EDITING);

        $("#subflow-input-name").val(subflow.name);
        subflowEditor.getSession().setValue(subflow.info,-1);
        var userCount = 0;
        var subflowType = "subflow:"+editing_node.id;

        RED.nodes.eachNode(function(n) {
            if (n.type === subflowType) {
                userCount++;
            }
        });

        $("#subflow-dialog-user-count").html(RED._("subflow.subflowInstances", {count:userCount})).show();
        $("#subflow-dialog").dialog("option","title",RED._("subflow.editSubflow",{name:subflow.name})).dialog( "open" );
    }



    return {
        init: function(){
            createDialog();
            createNodeConfigDialog();
            createSubflowDialog();
        },
        edit: showEditDialog,
        editConfig: showEditConfigNodeDialog,
        editSubflow: showEditSubflowDialog,
        validateNode: validateNode,
        updateNodeProperties: updateNodeProperties, // TODO: only exposed for edit-undo

        createEditor: function(options) {
            var editor = ace.edit(options.id);
            editor.setTheme("ace/theme/tomorrow");
            var session = editor.getSession();
            if (options.mode) {
                session.setMode(options.mode);
            }
            if (options.foldStyle) {
                session.setFoldStyle(options.foldStyle);
            } else {
                session.setFoldStyle('markbeginend');
            }
            if (options.options) {
                editor.setOptions(options.options);
            } else {
                editor.setOptions({
                    enableBasicAutocompletion:true,
                    enableSnippets:true
                });
            }
            editor.$blockScrolling = Infinity;
            if (options.value) {
                session.setValue(options.value,-1);
            }
            return editor;
        }
    }
})();
