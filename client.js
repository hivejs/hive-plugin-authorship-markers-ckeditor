/** 
 * hive.js 
 * Copyright (C) 2013-2016 Marcel Klehr <mklehr@gmx.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the Mozilla Public License version 2
 * as published by the Mozilla Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the Mozilla Public License
 * along with this program.  If not, see <https://www.mozilla.org/en-US/MPL/2.0/>.
 */

var vdom = require('virtual-dom')
  , h = vdom.h
  , nodeAt = require('domnode-at-path')
  , AtomicEmitter = require('atomic-emitter')

const SET_COLOR = 'AUTHORCOLORS_SET_COLOR' // Foreign action, see hive-plugin-author-colors
const LOAD_USER = 'AUTHORSHIPMARKERSCKEDITOR_LOAD_USER'
const UPDATE_ATTRIBUTIONS = 'AUTHORSHIPMARKERSCKEDITOR_UPDATE_ATTRIBUTIONSR'

module.exports = setup
module.exports.consumes = ['ui', 'editor', 'api', 'presence']
module.exports.provides = ['authorshipMarkersCkeditor']
function setup(plugin, imports, register) {
  var ui = imports.ui
    , editor = imports.editor
    , api = imports.api
    , presence = imports.presence

  ui.reduxReducerMap.authorshipMarkersCkeditor = reducer
  function reducer(state, action) {
    if(!state) {
      return {
        authors: {}
      , attributions: {}
      }
    }
    if(LOAD_USER === action.type) {
      return {...state, authors: {
        ...state.authors
      , [action.payload.id]: action.payload
      }}
    }
    if(UPDATE_ATTRIBUTIONS === action.type) {
      return {...state, attributions: action.payload}
    }
    // Hook into hive-plugin-author-colors
    if(SET_COLOR === action.type && state.authors[action.id]) {
      return {...state, authors: {
        ...state.authors
      , [action.id]: {
          ...state.authors[action.id]
          , attributes: {
            ...state.authors[action.id].attributes
            , color: action.payload
          }
        }
      }}
    }
    return state
  }

  var authorshipMarkers = {
    action_loadUser: function*(userId) {
      var user = yield api.action_user_get(userId)
      return yield {type: LOAD_USER, payload: user}
    }
  , action_updateAttributions: function(attributions) {
      return {type: UPDATE_ATTRIBUTIONS, payload: attributions}
    }
  , attributionsChanged: AtomicEmitter()
  }


  editor.onLoad((editableDocument, broadcast, onClose) => {
    // This plugin works with the default html editor only
    if(ui.store.getState().editor.editor !== 'CKeditor') return

    ui.store.dispatch({type: LOAD_USER
    , payload: ui.store.getState().session.user})

    var editorRoot = editableDocument.rootNode


    // Setup the rendering environment

    var tree = render(ui.store)
      , rootNode = vdom.create(tree)

    var dispose = ui.store.subscribe(_ => {
      var newtree = render(ui.store)
      var patches = vdom.diff(tree, newtree)
      vdom.patch(rootNode, patches)
      tree = newtree
    })

    var content = document.querySelector('.Editor__content')
    content.insertBefore(rootNode, content.firstChild)

    // If the main editor window is scrolled, scroll the markers, too
    editorRoot.addEventListener('scroll', function onscroll() {
      rootNode.scrollTop = editorRoot.scrollTop
    })

    var interval = setInterval(function() {
      var state = ui.store.getState().authorshipMarkersCkeditor
      Object.keys(state.authors)
      .map(function(authorId) {
        return ui.store.dispatch(authorshipMarkers.action_loadUser(authorId))
      })
    }, 10000)


    // Wire up attribution collection

    // on init
    editableDocument.on('editableInitialized',
      authorshipMarkers.attributionsChanged.emit)

    // if this user makes changes
    editableDocument.on('update', function(edit) {
      setTimeout(function() {
        // ...attribute the changes to them
        edit.changeset.forEach(function(op) {
          var path
          if(op.path) path = op.path
          if(op.to) path = op.to
          if(!path) return
          var node = nodeAt(path, editableDocument.rootNode)
          if(op.to && !op.from) resetAuthorsOfNode(node)
          addAuthorToNode(node, ui.store.getState().session.user.id)
        })
        authorshipMarkers.attributionsChanged.emit()
      }, 0)
    })

    // if someone else makes changes...
    editableDocument.on('edit', authorshipMarkers.attributionsChanged.emit)

    var dispose2 = authorshipMarkers.attributionsChanged(function() {
      var state = ui.store.getState().authorshipMarkersCkeditor

      // re-collect attributions
      var sectionsByAuthor = collectAttributions(editorRoot)

      // load any unknown author/user objects
      Promise.all(
        Object.keys(sectionsByAuthor)
        .map(function(authorId) {
          if(state.authors[authorId]) return Promise.resolve()
          return ui.store.dispatch(authorshipMarkers.action_loadUser(authorId))
        })
      ).then(function() {
        ui.store.dispatch(
          authorshipMarkers.action_updateAttributions(sectionsByAuthor)
        )
      })
    })

    onClose(_=> {
      dispose()
      dispose2()
      clearInterval(interval)
      editorRoot.removeEventListener('scroll', onscroll)
    })
  })

  register(null, {authorshipMarkersCkeditor: authorshipMarkers})
}

function render(store) {
  var state = store.getState().authorshipMarkersCkeditor
  // Visualize authorship by drawing lines for each author
  return h('div.AuthorshipMarkers',
    Object.keys(state.attributions).map((author) => {
      return h('div.AuthorshipMarkers__Section'
      , state.attributions[author].map(function(section) {
          return h('div.AuthorshipMarkers__Marker', {
            style: {
              'border-color': state.authors[author].attributes.color || '#777'
            , 'height': section.height+'px'
            , 'top': section.y+'px'
            }
          , attributes: {
              title: state.authors[author].attributes.name
            }
          })
        })
      )
    })
  )
}

function collectAttributions(rootNode) {
  // Extract authorship sections from the document
  var sections = seekAuthors(rootNode)
  var sectionsByAuthor = sortByAuthors(sections)
  return sectionsByAuthor
}

function seekAuthors(root, el, data) {
  if(!data) data = []
  if(!el) el = root
  for(var i=0; i<el.children.length; i++) {
    var node = el.children[i]
      , authors = getAuthorsOfNode(node)
      , boundingRect = node.getBoundingClientRect()
    var obj = {
      y: boundingRect.top-root.getBoundingClientRect().top
    , height: boundingRect.height
    , authors: authors
    }
    data.push(obj)
    seekAuthors(root, node, data)
  }
  return data
}
function sortByAuthors(sections) {
  var sectionsByAuthor = {}
  sections.forEach(function(section) {
    Object.keys(section.authors).forEach(function(author) {
      if(!sectionsByAuthor[author]) sectionsByAuthor[author] = []
      sectionsByAuthor[author].push({y: section.y, height: section.height})
    })
  })
  return sectionsByAuthor
}

function addAuthorToNode(node, userId) {
  if(!(node instanceof Element)) node = node.parentNode
  var authors = getAuthorsOfNode(node)

  authors[userId] = true

  node.setAttribute('data-author', Object.keys(authors).join(' '))
}

function resetAuthorsOfNode(node) {
  if(node instanceof Element) {
    node.setAttribute('data-author', '')
  }
}

function getAuthorsOfNode(node) {
  var authorstring = node.getAttribute('data-author')
    , authors
  if(!authorstring) authors = {}
  else authors = parseAuthors(authorstring)

  return authors
}

function parseAuthors(authorString) {
  var authors = {}
  authorString
  .split(' ')
  .forEach(function(authorId) {
    authors[authorId] = true
  })

  return authors
}
